// api/places.js — Vercel Serverless Function (Node.js)
//
// A chave da API fica SOMENTE aqui, em variavel de ambiente.
// O navegador nunca a recebe.
//
// Toda busca usa VARREDURA EM MOSAICO: a area e dividida em 7 setores
// (centro + 6 ao redor) e consultada em paralelo. Os resultados sao
// unidos, os repetidos descartados e o que caiu fora do raio e cortado.
// Custo: 7 chamadas ao Google por busca.
//
// Variaveis de ambiente na Vercel:
//   GOOGLE_MAPS_KEY   chave da API do Google (obrigatoria)
//   SEGREDO_ATIVACAO  segredo usado para validar as chaves (obrigatoria)
//   DOMINIO_PERMITIDO dominio do app, ex: maps-finder-six.vercel.app (opcional)
//   LIMITE_DIARIO     maximo de CHAMADAS por aparelho por dia
//                     (opcional, padrao 210 = cerca de 25 buscas)

import crypto from 'crypto';

const CHAVE = process.env.GOOGLE_MAPS_KEY;
const SEGREDO = process.env.SEGREDO_ATIVACAO || '';
const DOMINIO = process.env.DOMINIO_PERMITIDO || '';
const LIMITE_DIARIO = parseInt(process.env.LIMITE_DIARIO || '210', 10);

const SETORES = 7; // centro + 6 ao redor

// contador por aparelho — zera a cada reinicio da funcao
const contador = new Map();

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function chaveEsperada(idAparelho) {
  const hex = crypto
    .createHash('sha256')
    .update(idAparelho + '|' + SEGREDO)
    .digest('hex')
    .toUpperCase();
  const limpo = hex.replace(/[OI01]/g, '').slice(0, 12);
  return limpo.slice(0, 4) + '-' + limpo.slice(4, 8) + '-' + limpo.slice(8, 12);
}

function autorizado(idAparelho, chaveUsuario) {
  if (!SEGREDO) return true; // ativacao desligada
  if (!idAparelho || !chaveUsuario) return false;
  const esperada = Buffer.from(chaveEsperada(idAparelho));
  const recebida = Buffer.from(String(chaveUsuario).toUpperCase());
  if (esperada.length !== recebida.length) return false;
  return crypto.timingSafeEqual(esperada, recebida);
}

function dentroDaCota(idAparelho, peso) {
  const chave = hoje() + ':' + idAparelho;
  const n = (contador.get(chave) || 0) + (peso || 1);
  if (n > LIMITE_DIARIO) return false;
  contador.set(chave, n);
  if (contador.size > 5000) contador.clear();
  return true;
}

function origemValida(req) {
  if (!DOMINIO) return true;
  const ref = req.headers.origin || req.headers.referer || '';
  return ref.includes(DOMINIO);
}

function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

// centro + 6 setores ao redor, cobrindo o circulo original
function mosaico(lat, lng, raioKm) {
  const sub = raioKm * 0.55;
  const desloc = raioKm * 0.7;
  const cos = Math.cos((lat * Math.PI) / 180);
  const fator = 111 * (Math.abs(cos) < 0.01 ? 0.01 : cos);

  const pontos = [{ lat: lat, lng: lng, raioKm: sub }];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 3) * i;
    pontos.push({
      lat: lat + (desloc * Math.cos(ang)) / 111,
      lng: lng + (desloc * Math.sin(ang)) / fator,
      raioKm: sub
    });
  }
  return pontos;
}

function juntaSemRepetir(listas) {
  const vistos = new Set();
  const saida = [];
  for (const lista of listas) {
    for (const p of lista || []) {
      if (p && p.id && !vistos.has(p.id)) {
        vistos.add(p.id);
        saida.push(p);
      }
    }
  }
  return saida;
}

async function google(url, corpo, mascara) {
  const cabecalhos = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CHAVE };
  if (mascara) cabecalhos['X-Goog-FieldMask'] = mascara;

  const r = await fetch(url, {
    method: corpo ? 'POST' : 'GET',
    headers: cabecalhos,
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const dados = await r.json();
  if (!r.ok) {
    const msg = (dados && dados.error && dados.error.message) || 'Erro na API do Google';
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return dados;
}

const MASCARA = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount'
].join(',');

function normaliza(lista) {
  return (lista || []).map(function (p) {
    return {
      id: p.id,
      nome: (p.displayName && p.displayName.text) || '(sem nome)',
      endereco: p.formattedAddress || '',
      nota: p.rating || null,
      avaliacoes: p.userRatingCount || 0,
      lat: p.location ? p.location.latitude : null,
      lng: p.location ? p.location.longitude : null
    };
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Use POST' });
  if (!CHAVE) {
    return res.status(500).json({ erro: 'GOOGLE_MAPS_KEY nao configurada na Vercel' });
  }
  if (!origemValida(req)) return res.status(403).json({ erro: 'Origem nao autorizada' });

  const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const acao = corpo.acao;
  const aparelho = corpo.aparelho;
  const chave = corpo.chave;

  // --- verificar chave de ativacao (nao consome cota) ---
  if (acao === 'ativar') {
    if (!SEGREDO) return res.json({ ok: true, semAtivacao: true });
    return res.json({ ok: autorizado(aparelho, chave) });
  }

  if (!autorizado(aparelho, chave)) {
    return res.status(401).json({ erro: 'Aparelho nao autorizado' });
  }

  try {
    // --- sugestoes de lugar (1 chamada) ---
    if (acao === 'sugestoes') {
      const entrada = String(corpo.texto || '').trim();
      if (entrada.length < 2) return res.json({ sugestoes: [] });
      if (!dentroDaCota(aparelho, 1)) {
        return res.status(429).json({ erro: 'Limite diario atingido neste aparelho' });
      }

      const d = await google('https://places.googleapis.com/v1/places:autocomplete', {
        input: entrada,
        languageCode: 'pt-BR',
        regionCode: 'BR'
      });

      const sugestoes = (d.suggestions || [])
        .filter(function (s) {
          return s.placePrediction;
        })
        .slice(0, 6)
        .map(function (s) {
          return {
            id: s.placePrediction.placeId,
            texto: s.placePrediction.text ? s.placePrediction.text.text : ''
          };
        });
      return res.json({ sugestoes: sugestoes });
    }

    // --- coordenadas do lugar escolhido (1 chamada) ---
    if (acao === 'lugar') {
      if (!dentroDaCota(aparelho, 1)) {
        return res.status(429).json({ erro: 'Limite diario atingido neste aparelho' });
      }
      const id = String(corpo.id || '');
      const d = await google(
        'https://places.googleapis.com/v1/places/' + encodeURIComponent(id) + '?languageCode=pt-BR',
        null,
        'location,displayName,formattedAddress'
      );
      return res.json({
        lat: d.location.latitude,
        lng: d.location.longitude,
        nome: (d.displayName && d.displayName.text) || d.formattedAddress || ''
      });
    }

    const ehBusca = acao === 'proximos' || acao === 'porNome';
    if (!ehBusca) return res.status(400).json({ erro: 'Acao desconhecida' });

    const lat = Number(corpo.lat);
    const lng = Number(corpo.lng);
    const raioKm = Math.min(50, Math.max(0.1, Number(corpo.raio) / 1000));
    const tipo = corpo.tipo;

    if (!dentroDaCota(aparelho, SETORES)) {
      return res.status(429).json({ erro: 'Limite diario de buscas atingido neste aparelho' });
    }

    const pontos = mosaico(lat, lng, raioKm);

    const respostas = await Promise.all(
      pontos.map(function (pt) {
        // --- por proximidade: circulos ---
        if (acao === 'proximos') {
          const q = {
            maxResultCount: 20,
            rankPreference: 'POPULARITY',
            languageCode: 'pt-BR',
            locationRestriction: {
              circle: {
                center: { latitude: pt.lat, longitude: pt.lng },
                radius: Math.min(50000, pt.raioKm * 1000)
              }
            }
          };
          if (tipo) {
            if (corpo.ampla) q.includedTypes = [tipo];
            else q.includedPrimaryTypes = [tipo];
          }
          return google(
            'https://places.googleapis.com/v1/places:searchNearby',
            q,
            MASCARA
          ).catch(function () {
            return { places: [] };
          });
        }

        // --- por nome: retangulos ---
        const dLat = pt.raioKm / 111;
        const cos = Math.cos((pt.lat * Math.PI) / 180);
        const dLng = pt.raioKm / (111 * (Math.abs(cos) < 0.01 ? 0.01 : cos));
        const q = {
          textQuery: String(corpo.texto || ''),
          maxResultCount: 20,
          languageCode: 'pt-BR',
          locationRestriction: {
            rectangle: {
              low: {
                latitude: Math.max(-85, pt.lat - dLat),
                longitude: Math.max(-179.9, pt.lng - dLng)
              },
              high: {
                latitude: Math.min(85, pt.lat + dLat),
                longitude: Math.min(179.9, pt.lng + dLng)
              }
            }
          }
        };
        if (tipo) q.includedType = tipo;
        return google(
          'https://places.googleapis.com/v1/places:searchText',
          q,
          MASCARA
        ).catch(function () {
          return { places: [] };
        });
      })
    );

    const brutos = juntaSemRepetir(
      respostas.map(function (r) {
        return r.places;
      })
    );

    const dentro = brutos.filter(function (p) {
      if (!p.location) return true;
      return distKm(lat, lng, p.location.latitude, p.location.longitude) <= raioKm;
    });

    return res.json({ locais: normaliza(dentro), chamadas: pontos.length });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
