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
//   TETO_CHAMADAS     maximo de chamadas ao Google por busca (padrao 90).
//                     Controla o custo da varredura adaptativa.
//   PROFUNDIDADE_MAX  niveis de subdivisao de setores saturados (padrao 1)

import crypto from 'crypto';

const CHAVE = process.env.GOOGLE_MAPS_KEY;
const SEGREDO = process.env.SEGREDO_ATIVACAO || '';
const DOMINIO = process.env.DOMINIO_PERMITIDO || '';
const LIMITE_BUSCA_CATEGORIA = parseInt(process.env.LIMITE_BUSCA_CATEGORIA || '50', 10);
const LIMITE_BUSCA_TODAS = parseInt(process.env.LIMITE_BUSCA_TODAS || '15', 10);
const LIMITE_AUXILIAR = parseInt(process.env.LIMITE_AUXILIAR || '400', 10);

const SETORES = 7; // centro + 6 ao redor

// Teto de chamadas ao Google por busca. E o freio de custo: a varredura
// adaptativa so subdivide setores saturados enquanto houver orcamento.
// Se o orcamento acabar, a resposta vem marcada com truncou=true e o app
// avisa o usuario a reduzir o raio.
const TETO_CHAMADAS = parseInt(process.env.TETO_CHAMADAS || '63', 10);
// Quantos niveis de subdivisao sao permitidos (0 = comportamento antigo)
const PROFUNDIDADE_MAX = parseInt(process.env.PROFUNDIDADE_MAX || '1', 10);
// Quantas chamadas disparar em paralelo de cada vez (lotes grandes
// provocam RESOURCE_EXHAUSTED no Google)
const LOTE_MAX = parseInt(process.env.LOTE_MAX || '8', 10);

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

// Cada opcao do menu vira um GRUPO de tipos equivalentes da Tabela A do
// Google. Motivo: a Tabela A tem 468 tipos e usa nomes que o usuario nao
// adivinha -- "pousada" no Brasil e classificada como "inn", nao "hotel".
// Caso real: uma pousada com 445 avaliacoes na Ilha do Mel nao aparecia
// ao escolher Hotel, porque seu tipo primario era "inn".
// Como a Nearby Search aceita ate 50 tipos por chamada, expandir NAO
// aumenta o numero de chamadas.
const EXPANSAO = {
  restaurant: ["restaurant","fine_dining_restaurant","family_restaurant","diner","bistro",
    "buffet_restaurant","food_court","meal_delivery","meal_takeaway","brunch_restaurant",
    "breakfast_restaurant","american_restaurant","mediterranean_restaurant","asian_restaurant",
    "european_restaurant","latin_american_restaurant","fusion_restaurant","bar_and_grill"],
  cafe: ["cafe","coffee_shop","cafeteria","coffee_stand","coffee_roastery","tea_house",
    "cat_cafe","dog_cafe","internet_cafe","juice_shop","acai_shop"],
  bakery: ["bakery","pastry_shop","bagel_shop","donut_shop","confectionery"],
  bar: ["bar","cocktail_bar","sports_bar","lounge_bar","gastropub","beer_garden","brewpub",
    "brewery","winery","hookah_bar","snack_bar","oyster_bar_restaurant"],
  pub: ["pub","irish_pub","gastropub","brewpub"],
  wine_bar: ["wine_bar","winery"],
  night_club: ["night_club","dance_hall","karaoke","live_music_venue","comedy_club"],
  hamburger_restaurant: ["hamburger_restaurant","fast_food_restaurant","hot_dog_restaurant",
    "hot_dog_stand","sandwich_shop","chicken_wings_restaurant","chicken_restaurant"],
  japanese_restaurant: ["japanese_restaurant","sushi_restaurant","ramen_restaurant",
    "japanese_izakaya_restaurant","japanese_curry_restaurant","yakiniku_restaurant",
    "yakitori_restaurant","tonkatsu_restaurant"],
  sushi_restaurant: ["sushi_restaurant","japanese_restaurant"],
  chinese_restaurant: ["chinese_restaurant","cantonese_restaurant","chinese_noodle_restaurant",
    "dim_sum_restaurant","dumpling_restaurant","hot_pot_restaurant","noodle_shop"],
  steak_house: ["steak_house","barbecue_restaurant","brazilian_restaurant"],
  seafood_restaurant: ["seafood_restaurant","fish_and_chips_restaurant","oyster_bar_restaurant"],
  vegetarian_restaurant: ["vegetarian_restaurant","vegan_restaurant","health_food_store"],
  fast_food_restaurant: ["fast_food_restaurant","hamburger_restaurant","pizza_delivery",
    "hot_dog_stand","sandwich_shop"],
  ice_cream_shop: ["ice_cream_shop","dessert_shop","acai_shop","candy_store","chocolate_shop"],
  dessert_shop: ["dessert_shop","dessert_restaurant","pastry_shop","chocolate_shop",
    "candy_store","cake_shop"],
  pizza_restaurant: ["pizza_restaurant","pizza_delivery"],

  // hospedagem: "inn" e o tipo mais comum para pousada no Brasil
  hotel: ["hotel","inn","lodging","resort_hotel","extended_stay_hotel","motel",
    "bed_and_breakfast","guest_house","private_guest_room","hostel","cottage","farmstay",
    "japanese_inn","budget_japanese_inn"],
  motel: ["motel","lodging","inn"],
  resort_hotel: ["resort_hotel","hotel","lodging"],
  bed_and_breakfast: ["bed_and_breakfast","inn","guest_house","lodging","private_guest_room"],
  guest_house: ["guest_house","hostel","inn","bed_and_breakfast","lodging","private_guest_room"],
  campground: ["campground","camping_cabin","rv_park","mobile_home_park","farmstay","cottage"],

  gym: ["gym","fitness_center","sports_club","sports_activity_location","sports_complex"],
  fitness_center: ["fitness_center","gym","sports_club"],
  park: ["park","city_park","state_park","national_park","garden","botanical_garden",
    "picnic_ground","nature_preserve","wildlife_park","plaza"],
  tourist_attraction: ["tourist_attraction","historical_landmark","historical_place","monument",
    "cultural_landmark","observation_deck","visitor_center","scenic_spot","beach","island",
    "castle","fountain","sculpture"],
  museum: ["museum","art_museum","history_museum","cultural_center","planetarium"],
  art_gallery: ["art_gallery","art_museum","art_studio"],
  movie_theater: ["movie_theater","video_arcade"],
  performing_arts_theater: ["performing_arts_theater","opera_house","concert_hall",
    "philharmonic_hall","auditorium","amphitheatre","comedy_club"],
  shopping_mall: ["shopping_mall","department_store","hypermarket"],
  supermarket: ["supermarket","hypermarket","grocery_store","discount_supermarket",
    "asian_grocery_store","food_store","market","farmers_market"],
  grocery_store: ["grocery_store","supermarket","food_store","butcher_shop","market"],
  convenience_store: ["convenience_store","general_store","discount_store"],
  clothing_store: ["clothing_store","womens_clothing_store","sportswear_store","thrift_store"],
  electronics_store: ["electronics_store","cell_phone_store"],
  hardware_store: ["hardware_store","home_improvement_store","building_materials_store",
    "garden_center"],
  furniture_store: ["furniture_store","home_goods_store"],
  book_store: ["book_store","library"],
  pharmacy: ["pharmacy","drugstore"],
  drugstore: ["drugstore","pharmacy"],
  hospital: ["hospital","general_hospital","medical_center","medical_clinic"],
  doctor: ["doctor","medical_clinic","medical_center","chiropractor","physiotherapist"],
  dentist: ["dentist","dental_clinic"],
  spa: ["spa","massage_spa","massage","sauna","wellness_center","public_bath"],
  beauty_salon: ["beauty_salon","hair_salon","nail_salon","barber_shop","beautician",
    "makeup_artist","skin_care_clinic","tanning_studio"],
  hair_salon: ["hair_salon","barber_shop","hair_care","beauty_salon"],
  barber_shop: ["barber_shop","hair_salon","hair_care"],
  parking: ["parking","parking_lot","parking_garage","park_and_ride"],
  gas_station: ["gas_station","truck_stop","rest_stop"],
  car_repair: ["car_repair","tire_shop","auto_parts_store","car_wash"],
  airport: ["airport","international_airport","airstrip","heliport"],
  train_station: ["train_station","light_rail_station","transit_station","train_ticket_office"],
  bus_station: ["bus_station","bus_stop","transit_depot","transit_station"],
  subway_station: ["subway_station","tram_stop","transit_station"],
  taxi_stand: ["taxi_stand","taxi_service"],
  school: ["school","primary_school","secondary_school","preschool","educational_institution"],
  university: ["university","academic_department","research_institute","educational_institution"],
  library: ["library","book_store"],
  stadium: ["stadium","arena","athletic_field","sports_complex","race_course"],
  swimming_pool: ["swimming_pool","water_park"],
  amusement_park: ["amusement_park","amusement_center","water_park","ferris_wheel",
    "roller_coaster","video_arcade","adventure_sports_center"],
  playground: ["playground","indoor_playground"],
  zoo: ["zoo","wildlife_park","wildlife_refuge","aquarium"],
  travel_agency: ["travel_agency","tour_agency","tourist_information_center"],
  laundry: ["laundry"],
  bank: ["bank","atm"],
  atm: ["atm","bank"],
  storage: ["storage","moving_company"],
  local_government_office: ["local_government_office","government_office","city_hall"],
  // --- acrescentados na v1.3 (todos validados contra a API) ---
  police: ["police","neighborhood_police_station"],
  korean_restaurant: ["korean_restaurant","korean_barbecue_restaurant"],
  indian_restaurant: ["indian_restaurant","north_indian_restaurant","south_indian_restaurant"],
  mexican_restaurant: ["mexican_restaurant","taco_restaurant","burrito_restaurant","tex_mex_restaurant"],
  golf_course: ["golf_course","miniature_golf_course","indoor_golf_course"],
  sporting_goods_store: ["sporting_goods_store","sportswear_store"]
};

// expande a selecao do usuario, sem repetir tipos
function expandeTipos(escolhidos) {
  const fora = [];
  const jaTem = {};
  for (const t of escolhidos) {
    const grupo = EXPANSAO[t] || [t];
    for (const g of grupo) {
      if (!jaTem[g]) { jaTem[g] = true; fora.push(g); }
    }
  }
  return fora;
}

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

function espera(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// O Google impoe limite de requisicoes por minuto. Sob a varredura
// adaptativa, rajadas paralelas fazem parte das chamadas voltarem com
// RESOURCE_EXHAUSTED. Medido em 04/08/2026: um lote de 30 simultaneas
// teve 10 recusas. Sem reenvio, esses resultados sumiriam em silencio e
// a lista sairia incompleta sem ninguem perceber.
async function google(url, corpo, mascara, tentativas) {
  const cabecalhos = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CHAVE };
  if (mascara) cabecalhos['X-Goog-FieldMask'] = mascara;
  const maxTentativas = tentativas || 4;
  let ultimoErro = null;

  for (let i = 0; i < maxTentativas; i++) {
    let r, dados;
    try {
      r = await fetch(url, {
        method: corpo ? 'POST' : 'GET',
        headers: cabecalhos,
        body: corpo ? JSON.stringify(corpo) : undefined
      });
      dados = await r.json();
    } catch (falhaRede) {
      ultimoErro = falhaRede;
      await espera(220 * Math.pow(2, i) + Math.random() * 180);
      continue;
    }

    if (r.ok) return dados;

    const info = (dados && dados.error) || {};
    const excedeu = r.status === 429 || info.status === 'RESOURCE_EXHAUSTED';

    if (excedeu && i < maxTentativas - 1) {
      // espera progressiva com variacao, para nao reenviar tudo junto de novo
      await espera(260 * Math.pow(2, i) + Math.random() * 240);
      continue;
    }

    const e = new Error(info.message || 'Erro na API do Google');
    e.status = r.status;
    e.excedeu = excedeu;
    throw e;
  }

  const e = ultimoErro || new Error('Falha ao consultar o Google');
  e.status = e.status || 503;
  throw e;
}

const MASCARA = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.primaryTypeDisplayName'
].join(',');

function normaliza(lista) {
  return (lista || []).map(function (p) {
    return {
      id: p.id,
      nome: (p.displayName && p.displayName.text) || '(sem nome)',
      endereco: p.formattedAddress || '',
      nota: p.rating || null,
      avaliacoes: p.userRatingCount || 0,
      tipo: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || null,
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

    // Suporta selecao de VARIAS categorias. corpo.tipos e um array;
    // por compatibilidade, tambem aceita corpo.tipo (string unica).
    const tipos = Array.isArray(corpo.tipos)
      ? corpo.tipos.filter(Boolean)
      : (corpo.tipo ? [corpo.tipo] : []);

    // "Todas as categorias" na busca por proximidade: nenhum tipo
    // declarado. O Google sub-representa certos comercios nesse caso
    // (ver nota em BLOCOS_TIPOS) -- por isso o modo caro de 4 blocos.
    const semCategoria = acao === 'proximos' && tipos.length === 0;

    // Nearby Search aceita ate 50 tipos em includedPrimaryTypes numa
    // SO chamada -- por isso escolher varias categorias nao custa mais
    // que escolher uma, desde que sejam <= 50 (o menu tem 116 no total,
    // entao so agrupamos em blocos de 50 no caso raro de selecionar
    // quase tudo manualmente).
    const CHUNK = 50;
    function emBlocosDe50(lista) {
      const r = [];
      for (let i = 0; i < lista.length; i += CHUNK) r.push(lista.slice(i, i + CHUNK));
      return r;
    }

    // Text Search (busca por nome) so aceita UM tipo por chamada
    // (includedType, singular). Com varias categorias escolhidas,
    // rodamos uma chamada por tipo -- mas ate um teto, porque o custo
    // cresce direto com o numero de tipos. Acima do teto, a busca por
    // nome ignora a categoria (o texto digitado ja filtra bastante).
    const TETO_TIPOS_NOME = 6;

    let blocos;
    if (acao === 'proximos') {
      // expande cada categoria escolhida para seus tipos equivalentes
      const expandidos = expandeTipos(tipos);
      blocos = semCategoria ? BLOCOS_TIPOS : emBlocosDe50(expandidos).map(function (t) {
        return { incluir: t };
      });
    } else {
      blocos = (tipos.length === 0 || tipos.length > TETO_TIPOS_NOME)
        ? [null]
        : tipos.map(function (t) { return { incluir: [t] }; });
    }

    const tipoContagem = semCategoria ? 'todas' : 'categoria';
    const limiteContagem = semCategoria ? LIMITE_BUSCA_TODAS : LIMITE_BUSCA_CATEGORIA;

    if (!usaCota(aparelho, tipoContagem, limiteContagem)) {
      return res.status(429).json({
        erro: semCategoria
          ? 'Limite diario de buscas em "Todas as categorias" atingido neste aparelho'
          : 'Limite diario de buscas atingido neste aparelho'
      });
    }

    // ---- varredura adaptativa ----
    // Uma chamada que volta com exatamente 20 resultados significa que o
    // Google CORTOU a lista: existem mais lugares ali do que coube. Nesse
    // caso o setor e subdividido e consultado de novo, so onde houve corte.
    //
    // Sem isso, areas densas perdem locais importantes de forma silenciosa.
    // Caso real medido em 04/08/2026 (Ilha do Mel, raio 7 km): um setor
    // devolveu 20 resultados incluindo lugares de 39, 56 e 71 avaliacoes,
    // enquanto uma pousada de 445 avaliacoes ficou de fora. Subdividir
    // aquele setor a encontrou de imediato. Isso tambem confirma que
    // rankPreference POPULARITY nao ordena por numero de avaliacoes.

    function consulta(pt, bloco) {
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
          if (!semCategoria && corpo.ampla) q.includedTypes = bloco.incluir;
          else q.includedPrimaryTypes = bloco.incluir;
        } else if (bloco && bloco.excluir && bloco.excluir.length) {
          q.excludedPrimaryTypes = bloco.excluir;
        }
        return google('https://places.googleapis.com/v1/places:searchNearby', q, MASCARA)
          .catch(function () { falhas++; return { places: [] }; });
      }

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
      if (bloco && bloco.incluir && bloco.incluir.length === 1) {
        q.includedType = bloco.incluir[0];
      }
      return google('https://places.googleapis.com/v1/places:searchText', q, MASCARA)
        .catch(function () { falhas++; return { places: [] }; });
    }

    let falhas = 0;
    const pontos = mosaico(lat, lng, raioKm);
    const vistos = new Map();

    // Subdivide-se apenas o bloco "livre" (catch-all) quando a busca e
    // "todas as categorias", e sempre quando o usuario escolheu categorias
    // -- ai o bloco de tipos E o alvo. Assim o orcamento nao se dispersa
    // subdividindo os blocos-rede do modo generico.
    function podeSubdividir(bloco) {
      if (!semCategoria) return true;
      return !(bloco && bloco.incluir && bloco.incluir.length);
    }

    let fila = [];
    for (const bloco of blocos) {
      for (const pt of pontos) {
        fila.push({ pt: pt, bloco: bloco, nivel: 0, abre: podeSubdividir(bloco) });
      }
    }

    let chamadas = 0;
    let orcamento = TETO_CHAMADAS;
    let truncou = false;

    while (fila.length && orcamento > 0) {
      // respeita o orcamento e evita rajadas grandes demais de uma vez
      const lote = fila.splice(0, Math.min(fila.length, orcamento, LOTE_MAX));
      orcamento -= lote.length;
      chamadas += lote.length;

      const respostas = await Promise.all(
        lote.map(function (t) { return consulta(t.pt, t.bloco); })
      );

      const proxima = [];
      respostas.forEach(function (r, i) {
        const t = lote[i];
        const achados = (r && r.places) || [];
        for (const p of achados) {
          if (p && p.id && !vistos.has(p.id)) vistos.set(p.id, p);
        }
        // saturou: havia mais do que coube na resposta
        if (achados.length >= 20) {
          if (t.abre && t.nivel < PROFUNDIDADE_MAX) {
            const filhos = mosaico(t.pt.lat, t.pt.lng, t.pt.raioKm);
            for (const sub of filhos) {
              proxima.push({ pt: sub, bloco: t.bloco, nivel: t.nivel + 1, abre: true });
            }
          } else if (t.abre) {
            truncou = true;
          }
        }
      });

      fila = fila.concat(proxima);
    }

    if (fila.length) truncou = true;  // orcamento acabou antes de terminar
    if (falhas > 0) truncou = true;   // alguma chamada nao voltou: lista pode estar incompleta

    const brutos = [];
    vistos.forEach(function (p) { brutos.push(p); });

    const dentro = brutos.filter(function (p) {
      if (!p.location) return true;
      return distKm(lat, lng, p.location.latitude, p.location.longitude) <= raioKm;
    });

    return res.json({
      locais: normaliza(dentro),
      chamadas: chamadas,
      blocos: blocos.length,
      truncou: truncou,
      falhas: falhas
    });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message });
  }
}
