// ══════════════════════════════════════════════
// جوّك — iGnav Flight Search Server
// بحث فقط — لا يوجد حجز داخل هذا السيرفر.
// نفس صيغة نتائج SerpApi حتى يستطيع السيرفر الرئيسي
// دمج النتائج لاحقاً بدون تغيير الواجهة.
// ══════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const IGNAV_API_KEY = process.env.IGNAV_API_KEY || '';
const SERVICE_SECRET = process.env.IGNAV_SERVICE_SECRET || '';
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || '';

const IGNAV_BASE = (
  process.env.IGNAV_BASE || 'https://ignav.com/api'
).replace(/\/$/, '');

const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) || 20_000;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30;

const rateBuckets = new Map();

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (!MAIN_SERVER_URL) {
      return callback(null, true);
    }

    const allowed = MAIN_SERVER_URL
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);

    return callback(null, allowed.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'X-Ignav-Service-Secret'
  ],
}));

app.use(express.json({ limit: '50kb' }));

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for'] ||
    req.ip ||
    'unknown'
  )
    .split(',')[0]
    .trim();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);

  let bucket = rateBuckets.get(key);

  if (
    !bucket ||
    now - bucket.startedAt >= RATE_WINDOW_MS
  ) {
    bucket = {
      startedAt: now,
      count: 0
    };

    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil(
      (
        RATE_WINDOW_MS -
        (now - bucket.startedAt)
      ) / 1000
    );

    res.set('Retry-After', String(retryAfter));

    return res.status(429).json({
      error:
        'طلبات كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.'
    });
  }

  if (rateBuckets.size > 5000) {
    for (const [ip, item] of rateBuckets) {
      if (
        now - item.startedAt >=
        RATE_WINDOW_MS
      ) {
        rateBuckets.delete(ip);
      }
    }
  }

  next();
}

function requireServiceSecret(req, res, next) {
  if (!SERVICE_SECRET) {
    return next();
  }

  const received = String(
    req.headers['x-ignav-service-secret'] || ''
  );

  if (
    !received ||
    received !== SERVICE_SECRET
  ) {
    return res.status(401).json({
      error: 'غير مصرح لهذا الطلب.'
    });
  }

  next();
}

function validateSearchBody(body = {}) {
  const from = String(body.from || '')
    .trim()
    .toUpperCase();

  const to = String(body.to || '')
    .trim()
    .toUpperCase();

  const departDate = String(
    body.departDate || ''
  ).trim();

  const returnDate = body.returnDate
    ? String(body.returnDate).trim()
    : '';

  if (
    !/^[A-Z]{3}$/.test(from) ||
    !/^[A-Z]{3}$/.test(to)
  ) {
    return {
      error: 'بيانات المطارات غير صالحة.'
    };
  }

  if (from === to) {
    return {
      error:
        'مدينة المغادرة والوصول يجب أن تكونا مختلفتين.'
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) {
    return {
      error: 'تاريخ السفر غير صالح.'
    };
  }

  if (
    returnDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)
  ) {
    return {
      error: 'تاريخ العودة غير صالح.'
    };
  }

  const adults = Number(body.adults);
  const children = Number(body.children || 0);
  const infants = Number(body.infants || 0);

  const cabin = String(
    body.cabin || 'economy'
  ).toLowerCase();

  if (
    !Number.isInteger(adults) ||
    adults < 1 ||
    adults > 9
  ) {
    return {
      error: 'عدد البالغين غير صالح.'
    };
  }

  if (
    !Number.isInteger(children) ||
    children < 0 ||
    children > 8
  ) {
    return {
      error: 'عدد الأطفال غير صالح.'
    };
  }

  if (
    !Number.isInteger(infants) ||
    infants < 0 ||
    infants > 9 ||
    infants > adults
  ) {
    return {
      error: 'عدد الرضع غير صالح.'
    };
  }

  if (
    !new Set([
      'economy',
      'premium_economy',
      'business',
      'first'
    ]).has(cabin)
  ) {
    return {
      error: 'درجة السفر غير صالحة.'
    };
  }

  if (returnDate) {
    const dep = new Date(
      `${departDate}T00:00:00Z`
    );

    const ret = new Date(
      `${returnDate}T00:00:00Z`
    );

    if (
      Number.isNaN(dep.getTime()) ||
      Number.isNaN(ret.getTime())
    ) {
      return {
        error: 'تاريخ السفر غير صالح.'
      };
    }

    if (ret < dep) {
      return {
        error:
          'تاريخ العودة يجب أن يكون بعد أو مساويًا لتاريخ الذهاب.'
      };
    }
  }

  return {
    value: {
      from,
      to,
      departDate,
      returnDate,
      adults,
      children,
      infants,
      cabin
    }
  };
}

function makeId(value) {
  return crypto
    .createHash('sha1')
    .update(String(value))
    .digest('hex')
    .slice(0, 20);
}

function ignavTime(value) {
  const text = String(value || '');

  const match = text.match(
    /T(\d{2}:\d{2})/
  );

  if (match) {
    return match[1];
  }

  const plain = text.match(
    /(\d{2}:\d{2})/
  );

  return plain ? plain[1] : '';
}

function ignavDate(value) {
  const text = String(value || '');

  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})/
  );

  return match ? match[1] : '';
}

function normalizeIgnavLeg(leg) {
  if (
    !leg ||
    !Array.isArray(leg.segments) ||
    !leg.segments.length
  ) {
    return null;
  }

  const first = leg.segments[0];
  const last =
    leg.segments[leg.segments.length - 1];

  const airlineCode = String(
    first?.marketing_carrier_code || ''
  )
    .trim()
    .toUpperCase();

  const rawFlightNumber = String(
    first?.flight_number || ''
  ).trim();

  const flightNumber = airlineCode
    ? `${airlineCode}${rawFlightNumber}`
    : rawFlightNumber;

  const from = String(
    first?.departure_airport || ''
  )
    .trim()
    .toUpperCase();

  const to = String(
    last?.arrival_airport || ''
  )
    .trim()
    .toUpperCase();

  const depValue =
    first?.departure_time_local ||
    first?.departure_time_utc ||
    '';

  const arrValue =
    last?.arrival_time_local ||
    last?.arrival_time_utc ||
    '';

  const durationMinutes = Number(
    leg?.duration_minutes
  );

  return {
    from,
    to,
    depTime: ignavTime(depValue),
    arrTime: ignavTime(arrValue),
    depDate: ignavDate(depValue),
    arrDate: ignavDate(arrValue),
    durationMinutes:
      Number.isFinite(durationMinutes) &&
      durationMinutes >= 0
        ? Math.round(durationMinutes)
        : 0,
    stops: Math.max(
      0,
      leg.segments.length - 1
    ),
    flightNumber,
    airlineCode,
    airlineName:
      String(
        leg?.carrier ||
        first?.operating_carrier_name ||
        'شركة طيران'
      ).trim() || 'شركة طيران',
    airlineLogo: ''
  };
}

function normalizeBaggage(itinerary) {
  const bags =
    itinerary?.bags &&
    typeof itinerary.bags === 'object'
      ? itinerary.bags
      : {};

  const checked = Number(
    bags.checked
  );

  const carryOn = Number(
    bags.carry_on
  );

  const checkedValid =
    Number.isFinite(checked) &&
    checked > 0;

  const carryOnValid =
    Number.isFinite(carryOn) &&
    carryOn > 0;

  return {
    checkedIncluded: checkedValid,
    checkedQuantity: checkedValid
      ? Math.round(checked)
      : 0,
    checkedWeightKg: null,

    carryOnIncluded: carryOnValid,
    carryOnQuantity: carryOnValid
      ? Math.round(carryOn)
      : 0,
    carryOnWeightKg: null
  };
}

function normalizeItinerary(
  itinerary,
  index
) {
  const rawAmount = Number(
    itinerary?.price?.amount
  );

  const originalCurrency = String(
    itinerary?.price?.currency ||
    'EGP'
  )
    .trim()
    .toUpperCase();

  if (
    !Number.isFinite(rawAmount) ||
    rawAmount < 0
  ) {
    return null;
  }

  const outbound =
    normalizeIgnavLeg(
      itinerary?.outbound
    );

  if (!outbound) {
    return null;
  }

  const inbound =
    itinerary?.inbound
      ? normalizeIgnavLeg(
          itinerary.inbound
        )
      : null;

  const key = [
    outbound.airlineCode,
    outbound.flightNumber,
    outbound.from,
    outbound.to,
    outbound.depDate,
    outbound.depTime,
    outbound.arrDate,
    outbound.arrTime,

    inbound?.airlineCode || '',
    inbound?.flightNumber || '',
    inbound?.from || '',
    inbound?.to || '',
    inbound?.depDate || '',
    inbound?.depTime || '',
    inbound?.arrDate || '',
    inbound?.arrTime || '',

    rawAmount,
    originalCurrency,
    itinerary?.ignav_id || index
  ].join('|');

  return {
    id: `ignav_${makeId(key)}`,

    source: 'ignav',

    airlineCode:
      outbound.airlineCode,

    airlineName:
      outbound.airlineName,

    airlineLogo:
      outbound.airlineLogo,

    flightNumber:
      outbound.flightNumber,

    from: outbound.from,
    to: outbound.to,

    depTime:
      outbound.depTime,

    arrTime:
      outbound.arrTime,

    depDate:
      outbound.depDate,

    arrDate:
      outbound.arrDate,

    durationMinutes:
      outbound.durationMinutes,

    stops:
      outbound.stops,

    returnLeg:
      inbound
        ? {
            from: inbound.from,
            to: inbound.to,
            depTime: inbound.depTime,
            arrTime: inbound.arrTime,
            depDate: inbound.depDate,
            arrDate: inbound.arrDate,
            durationMinutes:
              inbound.durationMinutes,
            stops: inbound.stops,
            flightNumber:
              inbound.flightNumber,
            airlineCode:
              inbound.airlineCode,
            airlineName:
              inbound.airlineName
          }
        : null,

    // Ignav's round-trip response already returns
    // the total itinerary price. We do NOT add outbound
    // and inbound again.
    price:
      Math.round(rawAmount),

    currency:
      originalCurrency,

    originalPrice:
      rawAmount,

    originalCurrency,

    seatsLeft: null,

    cabin:
      itinerary?.cabin_class ||
      'economy',

    baggage:
      normalizeBaggage(itinerary),

    refundable: null,

    refundPenalty: null,

    refundPenaltyCurrency: null,

    // Kept for future booking-link integration.
    ignavId:
      itinerary?.ignav_id || null,

    requiresSelfTransfer:
      Boolean(
        itinerary?.requires_self_transfer
      )
  };
}

async function fetchIgnav(
  search
) {
  if (!IGNAV_API_KEY) {
    throw new Error(
      'خدمة iGnav غير مهيأة حالياً.'
    );
  }

  const isRoundTrip =
    Boolean(search.returnDate);

  const endpoint = isRoundTrip
    ? `${IGNAV_BASE}/fares/round-trip`
    : `${IGNAV_BASE}/fares/one-way`;

  const body = {
    origin: search.from,
    destination: search.to,
    departure_date: search.departDate,

    adults: search.adults,
    children: search.children,

    // Jawwak currently treats infants as lap infants.
    infants_on_lap: search.infants,

    cabin_class: search.cabin,

    // Ask iGnav for the Egypt market first.
    // If a market-local fare is available,
    // the API returns it in the local market currency.
    market: 'EG'
  };

  if (isRoundTrip) {
    body.return_date =
      search.returnDate;
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      endpoint,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Accept:
            'application/json',

          'X-Api-Key':
            IGNAV_API_KEY
        },

        body:
          JSON.stringify(body),

        signal:
          controller.signal
      }
    );

    const text =
      await response.text();

    let data = {};

    try {
      data = text
        ? JSON.parse(text)
        : {};
    } catch (_) {
      data = {};
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `iGnav returned ${response.status}`
      );
    }

    return Array.isArray(
      data?.itineraries
    )
      ? data.itineraries
      : [];
  } catch (err) {
    if (
      err?.name ===
      'AbortError'
    ) {
      throw new Error(
        'انتهت مهلة الاتصال بخدمة iGnav.'
      );
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'jawwak-ignav-flight-search',

      ignavConfigured:
        Boolean(IGNAV_API_KEY)
    });
  }
);

app.post(
  '/api/search-flights',
  rateLimit,
  requireServiceSecret,
  async (req, res) => {
    try {
      const validation =
        validateSearchBody(
          req.body
        );

      if (validation.error) {
        return res.status(400).json({
          error:
            validation.error
        });
      }

      if (!IGNAV_API_KEY) {
        return res.status(503).json({
          error:
            'خدمة iGnav غير مهيأة حالياً.'
        });
      }

      const search =
        validation.value;

      const itineraries =
        await fetchIgnav(search);

      const flights =
        itineraries
          .map(
            normalizeItinerary
          )
          .filter(Boolean);

      return res.json({
        flights,
        count: flights.length,

        // This reflects the actual currency
        // returned by iGnav for the EG market.
        currency:
          flights[0]?.currency ||
          'EGP'
      });
    } catch (err) {
      console.error(
        'iGnav service error:',
        err
      );

      return res.status(500).json({
        error:
          err?.message ||
          'تعذر إكمال البحث عبر iGnav حالياً.'
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Jawwak iGnav server running on port ${PORT}`
    );
  }
);