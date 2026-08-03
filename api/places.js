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
//   LIMITE_BUSCA_CATEGORIA  buscas por dia, por aparelho, com categoria
//                           escolhida (opcional, padrao 50)
//   LIMITE_BUSCA_TODAS      buscas por dia, por aparelho, em "Todas as
//                           categorias" -- mais cara, 3x mais chamadas
//                           (opcional, padrao 15)
//   LIMITE_AUXILIAR   teto de seguranca para sugestoes de autocomplete e
//                     detalhes de lugar, que nao contam como "busca"
//                     (opcional, padrao 400)

import crypto from 'crypto';

const CHAVE = process.env.GOOGLE_MAPS_KEY;
const SEGREDO = process.env.SEGREDO_ATIVACAO || '';
const DOMINIO = process.env.DOMINIO_PERMITIDO || '';
const LIMITE_BUSCA_CATEGORIA = parseInt(process.env.LIMITE_BUSCA_CATEGORIA || '50', 10);
const LIMITE_BUSCA_TODAS = parseInt(process.env.LIMITE_BUSCA_TODAS || '15', 10);
const LIMITE_AUXILIAR = parseInt(process.env.LIMITE_AUXILIAR || '400', 10);

const SETORES = 7; // centro + 6 ao redor

// Quando nenhuma categoria e escolhida, o Google aplica uma nocao interna
// de "popularidade" que penaliza certos tipos de comercio (lojas de
// eletronicos, por exemplo) mesmo com milhares de avaliacoes, favorecendo
// pontos turisticos. Testado e confirmado contra a API em 03/08/2026:
// uma Best Buy com 17.179 avaliacoes, a 570m do centro testado, nunca
// aparecia na busca sem filtro de tipo -- e passou a aparecer assim que
// o tipo foi declarado explicitamente.
//
// Correcao: quando a busca e "todas as categorias", declara-se os 116
// tipos que o app conhece, divididos em 3 blocos de ate 50 (limite da
// API), e roda-se cada bloco em cada um dos setores do mosaico.
//
// ISSO NAO E SUFICIENTE SOZINHO. A Tabela A oficial do Google (types
// aceitos por includedPrimaryTypes) tem 468 tipos distintos, nao 116 --
// qualquer estabelecimento cujo tipo primario seja um dos ~350 que
// faltam ficaria de fora dos 3 blocos. Foi o caso real de um
// restaurante em Curitiba (17.331 avaliacoes) cujo tipo primario e
// "cocktail_bar" -- um tipo que nao esta nos 116 do menu do app.
//
// Declarar os 468 tipos custaria 10 blocos x 7 setores = 70 chamadas,
// desproporcional. A solucao adotada foi um 4o bloco SEM QUALQUER
// FILTRO -- nem includedPrimaryTypes nem excludedPrimaryTypes -- que
// usa a propria classificacao de popularidade do Google para reunir
// mais candidatos, incluindo tipos raros fora dos 116 curados.
//
// Importante: nada e removido da lista final em nenhum bloco. Os
// blocos servem so para REUNIR candidatos (o teto de 20 por chamada
// do Google e a limitacao real); a lista mostrada ao usuario e o
// conjunto completo e unico de tudo o que foi encontrado nos 4
// blocos x 7 setores, ordenado por numero de avaliacoes, sem corte
// artificial em 20 nem em qualquer outro numero.
//
// Testado (04/08/2026): sem qualquer filtro no 4o bloco, um
// restaurante em Curitiba com 15.744 avaliacoes (tipo primario
// "cocktail_bar", fora dos 116 tipos do menu) apareceu normalmente.
//
// Custo final: 4 blocos x 7 setores = 28 chamadas (era 21).
//
// LIMITACAO QUE PERMANECE: o teto de 20 resultados por chamada do
// Google nao desaparece. Se, dentro de um mesmo bloco e setor,
// houver mais de 20 estabelecimentos com mais avaliacoes que um
// determinado local, esse local pode nao ser capturado por aquele
// bloco -- mas os outros 3 blocos e os outros 6 setores do mosaico
// aumentam bastante a chance de ele ser capturado por algum deles.
const BLOCOS_TIPOS = [
  { incluir: ["restaurant","cafe","coffee_shop","bakery","bar","pub","wine_bar","night_club",
   "pizza_restaurant","hamburger_restaurant","japanese_restaurant","sushi_restaurant",
   "italian_restaurant","chinese_restaurant","brazilian_restaurant","steak_house",
   "seafood_restaurant","vegetarian_restaurant","fast_food_restaurant","sandwich_shop",
   "ice_cream_shop","dessert_shop","hotel","motel","resort_hotel","bed_and_breakfast",
   "guest_house","campground","gym","fitness_center","yoga_studio","swimming_pool",
   "park","national_park","dog_park","playground","stadium","amusement_park",
   "tourist_attraction"] },
  { incluir: ["museum","art_gallery","zoo","aquarium","movie_theater","performing_arts_theater",
   "library","shopping_mall","supermarket","grocery_store","convenience_store",
   "department_store","clothing_store","shoe_store","electronics_store",
   "furniture_store","hardware_store","jewelry_store","book_store","pet_store",
   "florist","hospital","doctor","dentist","pharmacy","drugstore","physiotherapist",
   "veterinary_care","bank","atm","accounting","insurance_agency","real_estate_agency",
   "lawyer","travel_agency","gas_station","electric_vehicle_charging_station",
   "car_repair","car_wash"] },
  { incluir: ["car_dealer","car_rental","parking","airport","train_station","subway_station",
   "bus_station","taxi_stand","school","preschool","primary_school","secondary_school",
   "university","beauty_salon","hair_salon","barber_shop","nail_salon","spa","laundry",
   "church","mosque","synagogue","hindu_temple","post_office","police","fire_station",
   "city_hall","courthouse","embassy","local_government_office","cemetery",
   "funeral_home","storage","moving_company","plumber","electrician","painter",
   "roofing_contractor"] },
  {}
];

// contador por dia + aparelho + tipo de contagem — zera a cada reinicio da funcao
// 'aux'       -> sugestoes de autocomplete e detalhes de lugar (nao e busca)
// 'categoria' -> buscas com uma categoria especifica escolhida
// 'todas'     -> buscas em "Todas as categorias" (mais caras: 3 blocos)
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

function usaCota(idAparelho, tipoContagem, limite) {
  const chave = hoje() + ':' + idAparelho + ':' + tipoContagem;
  const n = (contador.get(chave) || 0) + 1;
  if (n > limite) return false;
  contador.set(chave, n);
  if (contador.size > 8000) contador.clear();
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
      if (!usaCota(aparelho, 'aux', LIMITE_AUXILIAR)) {
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
      if (!usaCota(aparelho, 'aux', LIMITE_AUXILIAR)) {
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

    // "Todas as categorias" na busca por proximidade: sem tipo declarado,
    // o Google sub-representa certos comercios (ver nota em BLOCOS_TIPOS).
    // Precisamos declarar todos os tipos, em blocos, para contornar isso.
    const semCategoria = acao === 'proximos' && !tipo;
    const blocos = semCategoria ? BLOCOS_TIPOS : [null];
    const tipoContagem = semCategoria ? 'todas' : 'categoria';
    const limiteContagem = semCategoria ? LIMITE_BUSCA_TODAS : LIMITE_BUSCA_CATEGORIA;

    if (!usaCota(aparelho, tipoContagem, limiteContagem)) {
      return res.status(429).json({
        erro: semCategoria
          ? 'Limite diario de buscas em "Todas as categorias" atingido neste aparelho'
          : 'Limite diario de buscas atingido neste aparelho'
      });
    }

    const pontos = mosaico(lat, lng, raioKm);

    const tarefas = [];
    for (const bloco of blocos) {
      for (const pt of pontos) {
        tarefas.push(
          (function (pt, bloco) {
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
              if (bloco && bloco.incluir && bloco.incluir.length) {
                q.includedPrimaryTypes = bloco.incluir;
              } else if (bloco && bloco.excluir && bloco.excluir.length) {
                q.excludedPrimaryTypes = bloco.excluir;
              } else if (tipo) {
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
          })(pt, bloco)
        );
      }
    }

    const respostas = await Promise.all(tarefas);

    const brutos = juntaSemRepetir(
      respostas.map(function (r) {
        return r.places;
      })
    );

    const dentro = brutos.filter(function (p) {
      if (!p.location) return true;
      return distKm(lat, lng, p.location.latitude, p.location.longitude) <= raioKm;
    });

    return res.json({
      locais: normaliza(dentro),
      chamadas: pontos.length,
      blocos: blocos.length
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
