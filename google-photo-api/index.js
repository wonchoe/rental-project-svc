import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || process.env.UNSLASH_ACCESS_KEY;
const UNSPLASH_ENABLE_FLAG = process.env.UNSPLASH_ENABLE ?? process.env.UNSLASH_ENABLE;
const UNSPLASH_ENABLED = typeof UNSPLASH_ENABLE_FLAG === 'string'
  ? UNSPLASH_ENABLE_FLAG.toLowerCase() === 'true'
  : Boolean(UNSPLASH_ACCESS_KEY);

const CITYPHOTO_CACHE_TTL_MS = Number(process.env.GOOGLE_CITYPHOTO_CACHE_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const REQUEST_CACHE_TTL_MS = Number(process.env.REQUEST_CACHE_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const REQUEST_CACHE_DIR = process.env.REQUEST_CACHE_DIR || path.join(process.cwd(), "cache", "requests");
const GOOGLE_PLACE_PHOTO_MAX_DIMENSION = 1600;
const GOOGLE_CITYPHOTO_STRATEGY_VERSION = "v4";
const GOOGLE_CITYPHOTO_DEFAULT_LIMIT = Number(process.env.GOOGLE_CITYPHOTO_DEFAULT_LIMIT || 100);
const GOOGLE_CITYPHOTO_MAX_LIMIT = Number(process.env.GOOGLE_CITYPHOTO_MAX_LIMIT || 120);
const GOOGLE_CITYPHOTO_MIN_WIDTH_DEFAULT = 1600;
const GOOGLE_CITYPHOTO_MIN_HEIGHT_DEFAULT = 1200;
const GOOGLE_CITYPHOTO_RADIUS_METERS = Number(process.env.GOOGLE_CITYPHOTO_RADIUS_METERS || 50000);
const GOOGLE_CITYPHOTO_PAGE_DELAY_MS = Number(process.env.GOOGLE_CITYPHOTO_PAGE_DELAY_MS || 2500);
const GOOGLE_CITYPHOTO_DISTANCE_TOLERANCE_MULTIPLIER = Number(process.env.GOOGLE_CITYPHOTO_DISTANCE_TOLERANCE_MULTIPLIER || 1.4);
const EXTERNAL_SEARCH_MAX_PAGES = Number(process.env.EXTERNAL_SEARCH_MAX_PAGES || 3);
const cityPhotoCache = new Map();
const STRICT_SEARCH_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "near", "city", "town", "country",
  "state", "region", "area", "view", "views", "photo", "photos", "image", "images",
  "in", "of", "a", "an", "de", "la", "el", "del", "da", "di"
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${pairs.join(",")}}`;
}

function hashCacheKey(namespace, payload) {
  const source = `${namespace}:${stableStringify(payload)}`;
  return crypto.createHash("sha1").update(source).digest("hex");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getRequestCache(namespace, payload, ttlMs = REQUEST_CACHE_TTL_MS) {
  try {
    const hash = hashCacheKey(namespace, payload);
    const folder = path.join(REQUEST_CACHE_DIR, namespace);
    const filePath = path.join(folder, `${hash}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const createdAt = Number(parsed.createdAt || 0);
    if (!createdAt || Date.now() - createdAt > ttlMs) {
      fs.rmSync(filePath, { force: true });
      return null;
    }

    return parsed.data ?? null;
  } catch (err) {
    console.warn(`Cache read failed for ${namespace}:`, err.message);
    return null;
  }
}

function setRequestCache(namespace, payload, data) {
  try {
    const hash = hashCacheKey(namespace, payload);
    const folder = path.join(REQUEST_CACHE_DIR, namespace);
    ensureDir(folder);

    const filePath = path.join(folder, `${hash}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          key: hash,
          namespace,
          createdAt: Date.now(),
          request: payload,
          data,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    console.warn(`Cache write failed for ${namespace}:`, err.message);
  }
}

function clearRequestCache(namespace, predicate = null) {
  const folder = path.join(REQUEST_CACHE_DIR, namespace);
  if (!fs.existsSync(folder)) {
    return 0;
  }

  let removed = 0;

  for (const filename of fs.readdirSync(folder)) {
    const filePath = path.join(folder, filename);

    try {
      if (!filename.endsWith(".json")) {
        continue;
      }

      if (predicate) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const request = parsed?.request ?? null;

        if (!predicate(request)) {
          continue;
        }
      }

      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch (err) {
      console.warn(`Cache clear failed for ${namespace}/${filename}:`, err.message);
    }
  }

  return removed;
}

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildCityPhotoCacheKey(payload) {
  return stableStringify(payload);
}

function getCityPhotoCache(payload) {
  const key = buildCityPhotoCacheKey(payload);
  const cached = cityPhotoCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CITYPHOTO_CACHE_TTL_MS) {
    cityPhotoCache.delete(key);
    return null;
  }
  return { key, data: cached.data };
}

function setCityPhotoCache(payload, data) {
  const key = buildCityPhotoCacheKey(payload);
  cityPhotoCache.set(key, { createdAt: Date.now(), data });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptionalKey(value) {
  const normalized = normalizeCityKey(value);
  return normalized || null;
}

function tokenizeStrictSearch(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STRICT_SEARCH_STOPWORDS.has(token));
}

function buildExternalSearchContext(req) {
  const location = String(req.query.location || req.query.city || "").trim();
  const term = String(req.query.term || "").trim();
  const searchQuery = [location, term].filter(Boolean).join(" ").trim() || location || term;
  const primaryLocation = String(location.split(",")[0] || location).trim();
  const strict = String(req.query.strict ?? "true").toLowerCase() !== "false";

  return {
    location,
    term,
    searchQuery,
    strict,
    normalizedLocation: normalizeSearchText(location),
    normalizedPrimaryLocation: normalizeSearchText(primaryLocation),
    primaryLocationTokens: tokenizeStrictSearch(primaryLocation),
    normalizedTerm: normalizeSearchText(term),
    termTokens: tokenizeStrictSearch(term),
  };
}

function buildStrictMetadataText(parts) {
  return normalizeSearchText(parts.filter(Boolean).join(" "));
}

function metadataMatchesStrictContext(metadataText, context) {
  if (!context.strict) {
    return true;
  }

  const haystack = normalizeSearchText(metadataText);
  if (!haystack) {
    return false;
  }

  let locationMatch = true;
  if (context.normalizedPrimaryLocation || context.primaryLocationTokens.length > 0) {
    locationMatch =
      (context.normalizedPrimaryLocation && haystack.includes(context.normalizedPrimaryLocation)) ||
      context.primaryLocationTokens.every((token) => haystack.includes(token));
  }

  let termMatch = true;
  if (context.normalizedTerm || context.termTokens.length > 0) {
    termMatch =
      (context.normalizedTerm && haystack.includes(context.normalizedTerm)) ||
      context.termTokens.every((token) => haystack.includes(token));
  }

  return locationMatch && termMatch;
}

function dedupeByKey(items, keyBuilder) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = String(keyBuilder(item) || "").trim();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function normalizeCountryFromAddress(formattedAddress) {
  const parts = String(formattedAddress || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function clampLegacyPhotoDimension(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.round(numeric), GOOGLE_PLACE_PHOTO_MAX_DIMENSION));
}

function normalizePositiveInt(value, fallback) {
  const numeric = Number(value || fallback);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.round(numeric);
}

function normalizeLimit(value, fallback) {
  return Math.min(normalizePositiveInt(value, fallback), GOOGLE_CITYPHOTO_MAX_LIMIT);
}

function isHighResolutionPhoto(photo, minWidth, minHeight) {
  const width = Number(photo?.width || 0);
  const height = Number(photo?.height || 0);
  const longestSide = Math.max(width, height);
  const shortestSide = Math.min(width, height);

  return Boolean(photo?.photo_reference) && longestSide >= minWidth && shortestSide >= minHeight;
}

function buildLegacyPhotoUrl(photoReference, maxwidth, maxheight) {
  const params = new URLSearchParams({
    maxwidth: String(maxwidth),
    maxheight: String(maxheight),
    photo_reference: String(photoReference),
    key: GOOGLE_API_KEY,
  });

  return `https://maps.googleapis.com/maps/api/place/photo?${params.toString()}`;
}

function createPhotoRecord(photo, place, sourceQuery, maxwidth, maxheight) {
  return {
    width: Number(photo?.width || 0),
    height: Number(photo?.height || 0),
    photo_reference: String(photo?.photo_reference || ""),
    place_id: place?.place_id || null,
    place_name: place?.name || null,
    source_query: sourceQuery,
    downloadUrl: buildLegacyPhotoUrl(photo.photo_reference, maxwidth, maxheight),
  };
}

function scorePhoto(record) {
  const width = Number(record?.width || 0);
  const height = Number(record?.height || 0);
  const area = width * height;
  const isLandscape = width >= height ? 1 : 0;

  return (area * 10) + isLandscape;
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceBetweenMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLng = degreesToRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degreesToRadians(lat1)) *
      Math.cos(degreesToRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function isPlaceRelevantToLocation(place, locationContext) {
  const placeLat = Number(place?.geometry?.location?.lat);
  const placeLng = Number(place?.geometry?.location?.lng);
  const centerLat = Number(locationContext?.lat);
  const centerLng = Number(locationContext?.lng);

  if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng) || !Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
    return true;
  }

  const distanceMeters = distanceBetweenMeters(centerLat, centerLng, placeLat, placeLng);
  return distanceMeters <= GOOGLE_CITYPHOTO_RADIUS_METERS * GOOGLE_CITYPHOTO_DISTANCE_TOLERANCE_MULTIPLIER;
}

function addHighResolutionPhotos(target, seenPhotoReferences, photos, place, sourceQuery, options) {
  const { minWidth, minHeight, maxwidth, maxheight, limit } = options;

  for (const photo of photos || []) {
    if (target.length >= limit) {
      break;
    }

    if (!isHighResolutionPhoto(photo, minWidth, minHeight)) {
      continue;
    }

    const photoReference = String(photo.photo_reference || "").trim();
    if (!photoReference || seenPhotoReferences.has(photoReference)) {
      continue;
    }

    seenPhotoReferences.add(photoReference);
    target.push(createPhotoRecord(photo, place, sourceQuery, maxwidth, maxheight));
  }
}

// Geocoding API: $5/1000 ($0.005) vs Find Place: $17/1000 ($0.017) — 3.4x cheaper
// Only returns coordinates + address, no place_id/photos — perfect for lite mode
const GEOCODE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 1 year — cities don't move

async function resolveLocationViaGeocode(query) {
  const cachePayload = { query: normalizeCityKey(query), api: "geocode" };
  const cached = getRequestCache("geocode", cachePayload, GEOCODE_CACHE_TTL_MS);
  if (cached) return cached;

  const response = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
    params: { address: query, key: GOOGLE_API_KEY },
  });

  const result = response.data.results?.[0] || null;
  if (!result?.geometry?.location) return null;

  const country = normalizeCountryFromAddress(result.formatted_address);
  const placeName = result.address_components?.find(c => c.types?.includes("locality"))?.long_name || query.split(",")[0].trim();
  const locationQuery = [placeName, country].filter(Boolean).join(", ");

  const context = {
    placeId: result.place_id || null,
    placeName,
    normalizedLocation: normalizeCityKey(locationQuery || query),
    country,
    formattedAddress: result.formatted_address || "",
    locationQuery: locationQuery || query,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
  };

  setRequestCache("geocode", cachePayload, context);
  return context;
}

async function resolveLocationContext(query) {
  const response = await axios.get("https://maps.googleapis.com/maps/api/place/findplacefromtext/json", {
    params: {
      input: query,
      inputtype: "textquery",
      fields: "place_id,name,geometry,formatted_address",
      key: GOOGLE_API_KEY,
    },
  });

  const candidate = response.data.candidates?.[0] || null;
  if (!candidate?.place_id) {
    return null;
  }

  const country = normalizeCountryFromAddress(candidate.formatted_address);
  const locationQuery = [candidate.name || query, country].filter(Boolean).join(", ");

  return {
    placeId: candidate.place_id,
    placeName: candidate.name || query,
    normalizedLocation: normalizeCityKey(locationQuery || query),
    country,
    formattedAddress: candidate.formatted_address || "",
    locationQuery: locationQuery || query,
    lat: candidate.geometry?.location?.lat ?? null,
    lng: candidate.geometry?.location?.lng ?? null,
  };
}

async function runTextSearch(query, locationContext, maxPages = 3) {
  const cachePayload = {
    query: normalizeCityKey(query),
    base_location: locationContext?.normalizedLocation || null,
    radius: GOOGLE_CITYPHOTO_RADIUS_METERS,
    strategy: GOOGLE_CITYPHOTO_STRATEGY_VERSION,
  };
  const cached = getRequestCache("cityphoto-query", cachePayload, CITYPHOTO_CACHE_TTL_MS);
  if (cached?.places) {
    return cached.places;
  }

  const places = [];
  let nextPageToken = null;
  let page = 0;

  while (page < maxPages) {
    if (page > 0) {
      await sleep(GOOGLE_CITYPHOTO_PAGE_DELAY_MS);
    }

    const params = nextPageToken
      ? {
          pagetoken: nextPageToken,
          key: GOOGLE_API_KEY,
        }
      : {
          query,
          key: GOOGLE_API_KEY,
          ...(locationContext?.lat != null && locationContext?.lng != null
            ? {
                location: `${locationContext.lat},${locationContext.lng}`,
                radius: GOOGLE_CITYPHOTO_RADIUS_METERS,
              }
            : {}),
        };

    const response = await axios.get("https://maps.googleapis.com/maps/api/place/textsearch/json", { params });
    const results = Array.isArray(response.data.results) ? response.data.results : [];

    places.push(...results
      .filter((place) => isPlaceRelevantToLocation(place, locationContext))
      .map((place) => ({
      ...place,
      __sourceQuery: query,
    })));

    nextPageToken = response.data.next_page_token || null;
    page += 1;

    if (!nextPageToken) {
      break;
    }
  }

  setRequestCache("cityphoto-query", cachePayload, {
    query,
    places,
  });

  return places;
}

async function getPlaceDetails(placeId) {
  const cachePayload = {
    place_id: String(placeId || "").trim(),
    strategy: GOOGLE_CITYPHOTO_STRATEGY_VERSION,
  };
  const cached = getRequestCache("cityphoto-details", cachePayload, CITYPHOTO_CACHE_TTL_MS);
  if (cached?.result) {
    return cached.result;
  }

  const response = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
    params: {
      place_id: placeId,
      fields: "photos,name,place_id",
      key: GOOGLE_API_KEY,
    },
  });

  const result = response.data.result || null;
  setRequestCache("cityphoto-details", cachePayload, { result });

  return result;
}

async function resolveGooglePhotoSignature(photoReference, maxwidth, maxheight) {
  const normalizedReference = String(photoReference || "").trim();
  if (!normalizedReference) {
    return null;
  }

  const cachePayload = {
    photo_reference: normalizedReference,
    maxwidth,
    maxheight,
    strategy: GOOGLE_CITYPHOTO_STRATEGY_VERSION,
  };
  const cached = getRequestCache("cityphoto-signature", cachePayload, CITYPHOTO_CACHE_TTL_MS);
  if (cached?.signature) {
    return cached.signature;
  }

  const photoUrl = buildLegacyPhotoUrl(normalizedReference, maxwidth, maxheight);

  try {
    const response = await axios.get(photoUrl, {
      responseType: "stream",
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const finalUrl =
      response.request?.res?.responseUrl ||
      response.request?.path ||
      photoUrl;
    const etag = String(response.headers?.etag || "").trim();
    const contentLength = String(response.headers?.["content-length"] || "").trim();

    response.data?.destroy?.();

    const signature = [finalUrl, etag, contentLength].filter(Boolean).join("|") || photoUrl;
    setRequestCache("cityphoto-signature", cachePayload, { signature });

    return signature;
  } catch (err) {
    console.warn("Photo signature resolve failed:", err.message);
    return `photo-reference:${normalizedReference}`;
  }
}


app.get("/pexels-photo", async (req, res) => {
  const search = buildExternalSearchContext(req);
  const limit = Number(req.query.limit || 10);
  const candidateLimit = Math.min(Math.max(limit * 3, limit), 80);
  const maxwidth = Number(req.query.width || 1600);
  const previewWidth = Number(req.query.preview || 600);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!search.searchQuery) {
    return res.status(400).json({ error: "location or city parameter required" });
  }

  if (!PEXELS_API_KEY) {
    console.error("Missing PEXELS_API_KEY");
    return res.status(500).json({ error: "PEXELS_API_KEY not configured" });
  }

  const cachePayload = {
    location: normalizeOptionalKey(search.location),
    term: normalizeOptionalKey(search.term),
    query: normalizeCityKey(search.searchQuery),
    strict: search.strict,
    limit,
    maxwidth,
    previewWidth,
    mode,
  };
  const cached = getRequestCache("pexels-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const rawPhotos = [];
    let page = 1;

    while (page <= EXTERNAL_SEARCH_MAX_PAGES && rawPhotos.length < candidateLimit) {
      const response = await axios.get(
        "https://api.pexels.com/v1/search",
        {
        params: {
          query: search.searchQuery,
          per_page: Math.min(candidateLimit, 80),
          page,
          ...(mode === "places" ? { orientation: "landscape" } : {}),
        },
        headers: {
          Authorization: PEXELS_API_KEY,
        },
      }
      );

      rawPhotos.push(...(response.data.photos || []));

      if (!response.data.next_page || !Array.isArray(response.data.photos) || response.data.photos.length === 0) {
        break;
      }

      page += 1;
    }

    const uniqueRawPhotos = dedupeByKey(rawPhotos, (photo) => photo.id);
    const filteredRawPhotos = uniqueRawPhotos.filter((photo) => metadataMatchesStrictContext(
      buildStrictMetadataText([
        photo.alt,
        photo.url,
        photo.photographer,
        photo.photographer_url,
      ]),
      search
    ));

    const photos = filteredRawPhotos.slice(0, limit).map((photo) => {
      const base = photo.src.original.split("?")[0];
      const previewH = Math.round(previewWidth / 16 * 9);

      return {
        id: photo.id,
        photographer: photo.photographer,
        alt: photo.alt,
        preview: `${base}?auto=compress&cs=tinysrgb&w=${previewWidth}&h=${previewH}&fit=crop`,
        full: `${base}?auto=compress&cs=tinysrgb&w=${maxwidth}`,
      };
    });

    const payload = {
      city: search.location || search.searchQuery,
      term: search.term || null,
      strict: search.strict,
      search_query: search.searchQuery,
      count: photos.length,
      candidates_before_filter: uniqueRawPhotos.length,
      filtered_out: Math.max(0, uniqueRawPhotos.length - photos.length),
      photos,
      cached: false,
    };

    setRequestCache("pexels-photo", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error(err.response?.data || err.message);
    const status = err.response?.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message || 'Failed to fetch photos';
    res.status(status).json({ error: msg });
  }
});

app.get("/pixabay-photo", async (req, res) => {
  const search = buildExternalSearchContext(req);
  const limit = Number(req.query.limit || 10);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!search.searchQuery) {
    return res.status(400).json({ error: "location or city parameter required" });
  }

  if (!PIXABAY_API_KEY) {
    console.error("Missing PIXABAY_API_KEY");
    return res.status(500).json({ error: "PIXABAY_API_KEY not configured" });
  }

  const cachePayload = {
    location: normalizeOptionalKey(search.location),
    term: normalizeOptionalKey(search.term),
    query: normalizeCityKey(search.searchQuery),
    strict: search.strict,
    limit,
    mode,
  };
  const cached = getRequestCache("pixabay-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const candidateLimit = Math.min(Math.max(limit * 3, limit), 200);
    const rawPhotos = [];
    let page = 1;

    while (page <= EXTERNAL_SEARCH_MAX_PAGES && rawPhotos.length < candidateLimit) {
      const response = await axios.get("https://pixabay.com/api/", {
        params: {
          key: PIXABAY_API_KEY,
          q: search.searchQuery,
          image_type: "photo",
          orientation: "horizontal",
          ...(mode === "places" ? { category: "places" } : {}),
          safesearch: true,
          min_width: 1600,
          min_height: 1200,
          per_page: Math.max(3, Math.min(candidateLimit, 200)),
          page,
        },
      });

      rawPhotos.push(...(response.data.hits || []));

      if (!Array.isArray(response.data.hits) || response.data.hits.length === 0) {
        break;
      }

      page += 1;
    }

    const uniqueRawPhotos = dedupeByKey(rawPhotos, (photo) => photo.id);
    const filteredRawPhotos = uniqueRawPhotos.filter((hit) => metadataMatchesStrictContext(
      buildStrictMetadataText([
        hit.tags,
        hit.pageURL,
        hit.user,
      ]),
      search
    ));

    const photos = filteredRawPhotos.slice(0, limit).map((hit) => {
      return {
        id: hit.id,
        user: hit.user,
        tags: hit.tags,
        preview: hit.webformatURL, // ~640px - good for grid preview
        full:
          hit.fullHDURL ||
          hit.largeImageURL || // 1280 fallback
          hit.webformatURL,    // 640 fallback
        width: hit.imageWidth,
        height: hit.imageHeight,
      };
    });

    const payload = {
      city: search.location || search.searchQuery,
      term: search.term || null,
      strict: search.strict,
      search_query: search.searchQuery,
      count: photos.length,
      total: photos.length,
      candidates_before_filter: uniqueRawPhotos.length,
      filtered_out: Math.max(0, uniqueRawPhotos.length - photos.length),
      photos,
      cached: false,
    };

    setRequestCache("pixabay-photo", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error(err.response?.data || err.message);
    const status = err.response?.status || 500;
    const msg = err.response?.data?.message || err.response?.data || err.message || 'Failed to fetch photos from Pixabay';
    res.status(status).json({ error: msg });
  }
});

function buildCityPhotoSearchQueries(locationContext, term = "", lite = false) {
  const baseQuery = locationContext?.locationQuery || "";
  const trimmedTerm = String(term || "").trim();
  const promptBase = trimmedTerm ? `${baseQuery} ${trimmedTerm}`.trim() : baseQuery;

  if (lite) {
    // Lite: use "attractions" suffix to get diverse results from Text Search
    // Searching just the city name returns only the city itself (1 place)
    // Adding "attractions" returns 10-20 landmarks/tourist spots with photos
    const liteQuery = trimmedTerm ? promptBase : `${baseQuery} attractions`.trim();
    return [liteQuery || baseQuery].filter(Boolean);
  }

  return Array.from(
    new Set([
      promptBase,
      `${promptBase} downtown`.trim(),
      `${promptBase} skyline view`.trim(),
    ].filter(Boolean))
  );
}

function clearGoogleCityPhotoCaches() {
  cityPhotoCache.clear();

  return {
    cityphoto: clearRequestCache("cityphoto"),
    query: clearRequestCache("cityphoto-query"),
    details: clearRequestCache("cityphoto-details"),
    signature: clearRequestCache("cityphoto-signature"),
    wikimedia: clearRequestCache("wikimedia-photo"),
  };
}

// GET /cityphoto?location=Tampa, USA&term=downtown skyline&limit=80&width=1600&height=1200&lite=true
app.get("/cityphoto", async (req, res) => {
  // Disabled — replaced by /wikimedia-photo (free) as primary source
  return res.status(503).json({ error: "Google Places API temporarily disabled. Use /wikimedia-photo instead.", photos: [], total: 0 });

  const requestedLocation = String(req.query.location || req.query.city || "").trim();
  const requestedTerm = String(req.query.term || "").trim();
  const limit = normalizeLimit(req.query.limit, GOOGLE_CITYPHOTO_DEFAULT_LIMIT);
  const candidateLimit = Math.min(Math.max(limit * 3, 180), 320);
  const maxwidth = clampLegacyPhotoDimension(req.query.width, GOOGLE_PLACE_PHOTO_MAX_DIMENSION);
  const maxheight = clampLegacyPhotoDimension(req.query.height, GOOGLE_CITYPHOTO_MIN_HEIGHT_DEFAULT);
  const minWidth = normalizePositiveInt(req.query.min_width, GOOGLE_CITYPHOTO_MIN_WIDTH_DEFAULT);
  const minHeight = normalizePositiveInt(req.query.min_height, GOOGLE_CITYPHOTO_MIN_HEIGHT_DEFAULT);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";
  // lite mode: skip Place Details + Photo Signature calls to save ~90% API cost
  const lite = String(req.query.lite ?? "true").toLowerCase() !== "false";

  if (!requestedLocation) return res.status(400).json({ error: "location parameter required" });

  if (mode !== "places") {
    return res.json({
      city: requestedLocation,
      total: 0,
      photos: [],
      cached: false,
      message: "Google Places supports places mode only",
    });
  }

  const cachePayload = {
    location: normalizeCityKey(requestedLocation),
    term: normalizeOptionalKey(requestedTerm),
    limit,
    maxwidth,
    maxheight,
    minWidth,
    minHeight,
    mode,
    lite,
    strategy: GOOGLE_CITYPHOTO_STRATEGY_VERSION,
  };

  const fileCached = getRequestCache("cityphoto", cachePayload, CITYPHOTO_CACHE_TTL_MS);
  if (fileCached) {
    setCityPhotoCache(cachePayload, fileCached);
    return res.json({ ...fileCached, cached: true, cache_source: "file" });
  }

  const memCached = getCityPhotoCache(cachePayload);
  if (memCached) {
    return res.json({ ...memCached.data, cached: true, cache_source: "memory" });
  }

  try {
    // Lite: Geocoding API ($0.005) vs Full: Find Place ($0.017), cached for 1 year
    const locationContext = lite
      ? await resolveLocationViaGeocode(requestedLocation)
      : await resolveLocationContext(requestedLocation);
    if (!locationContext) {
      return res.status(404).json({ error: "City not found" });
    }

    const searchQueries = buildCityPhotoSearchQueries(locationContext, requestedTerm, lite);

    const collectedPhotos = [];
    const seenPhotoReferences = new Set();
    const seenPlaceIds = new Set();
    const candidatePlaces = [];

    for (const searchQuery of searchQueries) {
      const places = await runTextSearch(searchQuery, locationContext, lite ? 1 : 3);

      for (const place of places) {
        if (place?.place_id && !seenPlaceIds.has(place.place_id)) {
          seenPlaceIds.add(place.place_id);
          candidatePlaces.push(place);
        }

        addHighResolutionPhotos(
          collectedPhotos,
          seenPhotoReferences,
          place?.photos || [],
          place,
          searchQuery,
          { minWidth, minHeight, maxwidth, maxheight, limit: candidateLimit }
        );

        if (collectedPhotos.length >= candidateLimit) {
          break;
        }
      }

      if (collectedPhotos.length >= candidateLimit) {
        break;
      }
    }

    if (!lite && collectedPhotos.length < candidateLimit) {
      for (const place of candidatePlaces) {
        if (!place?.place_id) {
          continue;
        }

        const details = await getPlaceDetails(place.place_id);
        addHighResolutionPhotos(
          collectedPhotos,
          seenPhotoReferences,
          details?.photos || [],
          details || place,
          place.__sourceQuery || locationContext.locationQuery,
          { minWidth, minHeight, maxwidth, maxheight, limit: candidateLimit }
        );

        if (collectedPhotos.length >= candidateLimit) {
          break;
        }
      }
    }

    // Lite fallback: only if we got ZERO photos from inline results, fetch details for 3 top places
    if (lite && collectedPhotos.length === 0 && candidatePlaces.length > 0) {
      const detailsLimit = Math.min(candidatePlaces.length, 3);
      for (let i = 0; i < detailsLimit; i++) {
        const place = candidatePlaces[i];
        if (!place?.place_id) continue;

        const details = await getPlaceDetails(place.place_id);
        addHighResolutionPhotos(
          collectedPhotos,
          seenPhotoReferences,
          details?.photos || [],
          details || place,
          place.__sourceQuery || locationContext.locationQuery,
          { minWidth, minHeight, maxwidth, maxheight, limit: candidateLimit }
        );

        if (collectedPhotos.length >= limit) break;
      }
    }

    const rankedPhotos = collectedPhotos
      .sort((a, b) => scorePhoto(b) - scorePhoto(a))
      .slice(0, candidateLimit);

    let dedupedPhotos;
    let duplicatesFiltered = 0;

    if (lite) {
      // Lite mode: skip expensive photo signature API calls
      // Limit per place to avoid 11 photos of the same Clock Tower
      const seenRefs = new Set();
      const placePhotoCount = new Map();
      const maxPerPlace = 3;
      dedupedPhotos = [];
      for (const photo of rankedPhotos) {
        const ref = String(photo.photo_reference || "").trim();
        if (ref && seenRefs.has(ref)) {
          duplicatesFiltered++;
          continue;
        }
        // Limit photos per place_id to ensure variety
        const pid = photo.place_id || "unknown";
        const count = placePhotoCount.get(pid) || 0;
        if (count >= maxPerPlace) {
          duplicatesFiltered++;
          continue;
        }
        placePhotoCount.set(pid, count + 1);
        if (ref) seenRefs.add(ref);
        dedupedPhotos.push(photo);
        if (dedupedPhotos.length >= limit) break;
      }
    } else {
      // Full mode: resolve photo signatures via Place Photos API for accurate dedup
      dedupedPhotos = [];
      const seenPhotoSignatures = new Set();

      for (const photo of rankedPhotos) {
        const signature = await resolveGooglePhotoSignature(photo.photo_reference, maxwidth, maxheight);
        if (signature && seenPhotoSignatures.has(signature)) {
          duplicatesFiltered++;
          continue;
        }

        if (signature) {
          seenPhotoSignatures.add(signature);
        }

        dedupedPhotos.push(photo);

        if (dedupedPhotos.length >= limit) {
          break;
        }
      }
    }

    const photoData = dedupedPhotos.map(({ photo_reference, ...photo }) => photo);

    if (photoData.length === 0) {
      return res.status(404).json({ error: "No high-resolution photos available for this city" });
    }

    const payload = {
      city: requestedLocation,
      term: requestedTerm || null,
      resolved_query: locationContext.locationQuery,
      requested_limit: limit,
      min_width: minWidth,
      min_height: minHeight,
      lite,
      total: photoData.length,
      photos: photoData,
      candidates_before_dedupe: rankedPhotos.length,
      duplicates_filtered: duplicatesFiltered,
      search_queries: searchQueries,
      places_considered: candidatePlaces.length,
      cached: false,
    };

    setCityPhotoCache(cachePayload, payload);
    setRequestCache("cityphoto", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error("❌ Error fetching city photo:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/cityphoto/cache/reset", authMiddleware, (req, res) => {
  const cleared = clearGoogleCityPhotoCaches();

  return res.json({
    success: true,
    cleared,
  });
});


// GET /unsplash-photo?city=Tampa&limit=30&width=4000
app.get("/unsplash-photo", async (req, res) => {
  // Check if Unsplash is enabled
  const isEnabled = UNSPLASH_ENABLED;
  
  if (!isEnabled) {
    return res.json({
      city: req.query.city || '',
      page: 1,
      count: 0,
      total: 0,
      total_pages: 0,
      photos: [],
      message: 'Unsplash is disabled'
    });
  }

  const search = buildExternalSearchContext(req);
  const limit = Number(req.query.limit || 30);
  const maxwidth = Number(req.query.width || 4000);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!search.searchQuery) {
    return res.status(400).json({ error: "location or city parameter required" });
  }

  if (!UNSPLASH_ACCESS_KEY) {
    console.error("Missing UNSPLASH_ACCESS_KEY");
    return res.status(500).json({ error: "UNSPLASH_ACCESS_KEY not configured" });
  }

  const cachePayload = {
    location: normalizeOptionalKey(search.location),
    term: normalizeOptionalKey(search.term),
    query: normalizeCityKey(search.searchQuery),
    strict: search.strict,
    limit,
    maxwidth,
    mode,
  };
  const cached = getRequestCache("unsplash-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const candidateLimit = Math.max(limit * 3, limit);
    const rawPhotos = [];
    let page = 1;
    let totalPages = 1;

    while (page <= EXTERNAL_SEARCH_MAX_PAGES && page <= totalPages && rawPhotos.length < candidateLimit) {
      const response = await axios.get("https://api.unsplash.com/search/photos", {
        params: {
          query: search.searchQuery,
          per_page: Math.min(candidateLimit, 30),
          page,
          ...(mode === "places" ? { orientation: "landscape" } : {}),
          order_by: "relevant",
        },
        headers: {
          Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
        },
      });

      totalPages = Number(response.data.total_pages || 1);
      rawPhotos.push(...(response.data.results || []));

      if (!Array.isArray(response.data.results) || response.data.results.length === 0) {
        break;
      }

      page += 1;
    }

    const uniqueRawPhotos = dedupeByKey(rawPhotos, (photo) => photo.id);
    const filteredRawPhotos = uniqueRawPhotos.filter((photo) => metadataMatchesStrictContext(
      buildStrictMetadataText([
        photo.alt_description,
        photo.description,
        photo.slug,
        photo.user?.location,
      ]),
      search
    ));

    const photos = filteredRawPhotos.slice(0, limit).map((photo) => {
      return {
        id: photo.id,
        photographer: photo.user.name,
        username: photo.user.username,
        alt: photo.alt_description || photo.description || search.searchQuery,
        preview: photo.urls.small, // 400px width
        full: `${photo.urls.raw}&w=${maxwidth}&fit=max&q=80`,
        width: photo.width,
        height: photo.height,
        color: photo.color,
        likes: photo.likes,
      };
    });

    const payload = {
      city: search.location || search.searchQuery,
      term: search.term || null,
      strict: search.strict,
      search_query: search.searchQuery,
      count: photos.length,
      total: photos.length,
      total_pages: totalPages,
      candidates_before_filter: uniqueRawPhotos.length,
      filtered_out: Math.max(0, uniqueRawPhotos.length - photos.length),
      photos,
      cached: false,
    };

    setRequestCache("unsplash-photo", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error("Unsplash error:", err.response?.data || err.message);
    const status = err.response?.status || 500;
    const msg = err.response?.data?.errors?.[0] || err.message || "Failed to fetch photos from Unsplash";
    res.status(status).json({ error: msg });
  }
});

// GET /freepik-search?term=feedback&limit=40&page=1&locale=en
app.get("/freepik-search", async (req, res) => {
  const term = String(req.query.term || req.query.city || "").trim();
  const limit = Number(req.query.limit || 40);
  const page = Number(req.query.page || 1);
  const locale = String(req.query.locale || "en").trim() || "en";

  if (!term) {
    return res.status(400).json({ error: "term parameter required" });
  }

  const cachePayload = {
    term: normalizeCityKey(term),
    limit,
    page,
    locale,
  };

  const cached = getRequestCache("freepik-search", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const response = await axios.get("https://www.freepik.com/api/regular/search", {
      params: {
        locale,
        term,
      },
      headers: {
        accept: "*/*",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        referer: `https://www.freepik.com/search?format=search&query=${encodeURIComponent(term)}`,
      },
      timeout: 20000,
    });

    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    const photos = items.slice(0, Math.max(1, Math.min(limit, 100))).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      premium: Boolean(item.premium),
      preview: item.preview?.url || null,
      full: item.preview?.url || null,
      assetUrl: item.url || null,
      author: item.author?.name || null,
      width: item.preview?.width || null,
      height: item.preview?.height || null,
    }));

    const payload = {
      term,
      page,
      count: photos.length,
      total: Number(response.data?.pagination?.total || 0),
      photos,
      cached: false,
    };

    setRequestCache("freepik-search", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error("Freepik error:", err.response?.data || err.message);
    const status = err.response?.status || 500;
    const msg = err.response?.data?.message || err.message || "Failed to fetch assets from Freepik";
    res.status(status).json({ error: msg });
  }
});

// 🔐 Simple Bearer Token Auth Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader) {
    return res.status(403).json({ error: "Missing Authorization header" });
  }


  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || token !== process.env.API_SECRET_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  next();
}

app.use(authMiddleware);

// GET /wikimedia-photo?location=Tbilisi,+Georgia&limit=30
const WIKIMEDIA_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — Commons photos stable
const WIKIMEDIA_API_BASE = "https://commons.wikimedia.org/w/api.php";
const WIKIMEDIA_USER_AGENT = "rental-photo-api/1.0 (automated city photo search; car-rental-site-generator)";

app.get("/wikimedia-photo", async (req, res) => {
  const location = String(req.query.location || req.query.city || "").trim();
  const limit = Math.min(Number(req.query.limit || 30), 100);
  // How many 50-file pages to fetch per category (1 page = 50 files)
  const maxCategoryPages = Math.ceil(limit / 50) + 1;
  const iiurlwidth = 1600;

  if (!location) {
    return res.status(400).json({ error: "location parameter required" });
  }

  const cityName = location.split(",")[0].trim();
  const cachePayload = { city: normalizeCityKey(cityName), limit, iiurlwidth };

  const cached = getRequestCache("wikimedia-photo", cachePayload, WIKIMEDIA_CACHE_TTL_MS);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  async function fetchWikimediaCategory(categoryTitle, maxPages = 3) {
    try {
      const allPages = [];
      let continueToken = null;
      let page = 0;

      while (page < maxPages) {
        const params = {
          action: "query",
          generator: "categorymembers",
          gcmtitle: `Category:${categoryTitle}`,
          gcmtype: "file",
          gcmlimit: 50,
          prop: "imageinfo",
          iiprop: "url|size",
          iiurlwidth,
          format: "json",
        };
        if (continueToken) {
          params.gcmcontinue = continueToken;
        }
        const response = await axios.get(WIKIMEDIA_API_BASE, {
          params,
          headers: { "User-Agent": WIKIMEDIA_USER_AGENT },
          timeout: 10000,
        });
        allPages.push(...Object.values(response.data?.query?.pages || {}));
        continueToken = response.data?.continue?.gcmcontinue || null;
        page++;
        if (!continueToken) break;
      }
      return allPages;
    } catch {
      return [];
    }
  }

  async function fetchWikimediaGeosearch(lat, lng) {
    try {
      const response = await axios.get(WIKIMEDIA_API_BASE, {
        params: {
          action: "query",
          generator: "geosearch",
          ggsnamespace: 6,
          ggscoord: `${lat}|${lng}`,
          ggsradius: 10000,
          ggslimit: 50,
          prop: "imageinfo",
          iiprop: "url|size",
          iiurlwidth,
          format: "json",
        },
        headers: { "User-Agent": WIKIMEDIA_USER_AGENT },
        timeout: 10000,
      });
      return Object.values(response.data?.query?.pages || {});
    } catch {
      return [];
    }
  }

  function isPhotoPage(page) {
    const title = String(page.title || "").toLowerCase();
    // Only real photos, no maps/logos/flags/coats of arms
    if (!/\.(jpg|jpeg|png|webp)$/.test(title)) return false;
    if (/\b(map|flag|coat|arms|logo|icon|diagram|plan|illustration|emblem|stamp|coin)\b/.test(title)) return false;
    return true;
  }

  function pageToPhoto(page) {
    const ii = page.imageinfo?.[0];
    if (!ii?.thumburl || !ii?.url) return null;
    return {
      id: String(page.pageid || page.title),
      title: String(page.title || "").replace("File:", ""),
      preview: ii.thumburl,
      full: ii.url,
      width: ii.thumbwidth || iiurlwidth,
      height: ii.thumbheight || Math.round(iiurlwidth * 0.75),
    };
  }

  try {
    const seenIds = new Set();
    const allPages = [];

    const addPages = (pages) => {
      for (const p of pages) {
        const id = p.pageid || p.title;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allPages.push(p);
        }
      }
    };

    // 1. Category-based: try subcategories first (best quality), then city itself
    const categoriesToTry = [
      `Views of ${cityName}`,
      `Panoramas of ${cityName}`,
      `Landscapes of ${cityName}`,
      cityName,
    ];

    for (const cat of categoriesToTry) {
      if (allPages.filter(isPhotoPage).length >= limit * 2) break;
      addPages(await fetchWikimediaCategory(cat, maxCategoryPages));
    }

    // 2. Geosearch fallback if not enough photos
    if (allPages.filter(isPhotoPage).length < limit) {
      const geo = await resolveLocationViaGeocode(location);
      if (geo?.lat && geo?.lng) {
        addPages(await fetchWikimediaGeosearch(geo.lat, geo.lng));
      }
    }

    const photos = allPages
      .filter(isPhotoPage)
      .map(pageToPhoto)
      .filter(Boolean)
      .slice(0, limit);

    const payload = {
      city: location,
      total: photos.length,
      photos,
      cached: false,
    };

    setRequestCache("wikimedia-photo", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error("Wikimedia fetch error:", err.message);
    res.status(500).json({ error: "Wikimedia fetch failed", photos: [], total: 0 });
  }
});

app.listen(process.env.PORT, () =>
  console.log(`✅ Google Photo API running on port ${process.env.PORT}`)
);
