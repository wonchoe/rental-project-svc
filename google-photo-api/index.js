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
const cityPhotoCache = new Map();

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

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCityPhotoCache(city, limit, maxwidth, maxheight) {
  const key = `${normalizeCityKey(city)}|${limit}|${maxwidth}|${maxheight}`;
  const cached = cityPhotoCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CITYPHOTO_CACHE_TTL_MS) {
    cityPhotoCache.delete(key);
    return null;
  }
  return { key, data: cached.data };
}

function setCityPhotoCache(city, limit, maxwidth, maxheight, data) {
  const key = `${normalizeCityKey(city)}|${limit}|${maxwidth}|${maxheight}`;
  cityPhotoCache.set(key, { createdAt: Date.now(), data });
}


app.get("/pexels-photo", async (req, res) => {
  const city = req.query.city;
  const limit = Number(req.query.limit || 10);
  const maxwidth = Number(req.query.width || 1600);
  const previewWidth = Number(req.query.preview || 600);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!city) {
    return res.status(400).json({ error: "city parameter required" });
  }

  if (!PEXELS_API_KEY) {
    console.error("Missing PEXELS_API_KEY");
    return res.status(500).json({ error: "PEXELS_API_KEY not configured" });
  }

  const cachePayload = { city: normalizeCityKey(city), limit, maxwidth, previewWidth, mode };
  const cached = getRequestCache("pexels-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const response = await axios.get(
      "https://api.pexels.com/v1/search",
      {
        params: {
          query: city,
          // Pexels limits per_page to a maximum of 80
          per_page: Math.min(limit, 80),
          ...(mode === "places" ? { orientation: "landscape" } : {}),
        },
        headers: {
          Authorization: PEXELS_API_KEY,
        },
      }
    );

    const photos = response.data.photos.map((photo) => {
      const base = photo.src.original.split("?")[0];
      // Preview: 600px width, 16:9 aspect = 600x338
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
      city,
      count: photos.length,
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
  const city = req.query.city;
  const limit = Number(req.query.limit || 10);
  const page = Number(req.query.page || 1);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!city) {
    return res.status(400).json({ error: "city parameter required" });
  }

  if (!PIXABAY_API_KEY) {
    console.error("Missing PIXABAY_API_KEY");
    return res.status(500).json({ error: "PIXABAY_API_KEY not configured" });
  }

  const cachePayload = { city: normalizeCityKey(city), limit, page, mode };
  const cached = getRequestCache("pixabay-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const response = await axios.get("https://pixabay.com/api/", {
      params: {
        key: PIXABAY_API_KEY,
        q: city,
        image_type: "photo",
        orientation: "horizontal",
        ...(mode === "places" ? { category: "places" } : {}),
        safesearch: true,
        per_page: Math.max(3, Math.min(limit, 200)),
        page,
      },
    });

    const photos = response.data.hits.map((hit) => {
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
      city,
      page,
      count: photos.length,
      total: response.data.totalHits,
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

// GET /cityphoto?city=Tampa, Florida&limit=25&width=4096&height=2304
app.get("/cityphoto", async (req, res) => {
  const city = req.query.city;
  const limit = Number(req.query.limit || 10);
  const maxwidth = Number(req.query.width || 1600);
  const maxheight = Number(req.query.height || 900);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!city) return res.status(400).json({ error: "city parameter required" });

  if (mode !== "places") {
    return res.json({
      city,
      total: 0,
      photos: [],
      cached: false,
      message: "Google Places supports places mode only",
    });
  }

  const cachePayload = { city: normalizeCityKey(city), limit, maxwidth, maxheight, mode };

  const fileCached = getRequestCache("cityphoto", cachePayload, CITYPHOTO_CACHE_TTL_MS);
  if (fileCached) {
    setCityPhotoCache(city, limit, maxwidth, maxheight, fileCached);
    return res.json({ ...fileCached, cached: true, cache_source: "file" });
  }

  const memCached = getCityPhotoCache(city, limit, maxwidth, maxheight);
  if (memCached) {
    return res.json({ ...memCached.data, cached: true, cache_source: "memory" });
  }

  try {
    // 1️⃣ Отримуємо place_id
    const find = await axios.get("https://maps.googleapis.com/maps/api/place/findplacefromtext/json", {
      params: {
        input: city,
        inputtype: "textquery",
        fields: "place_id",
        key: GOOGLE_API_KEY,
      },
    });

    const placeId = find.data.candidates?.[0]?.place_id;
    if (!placeId) return res.status(404).json({ error: "City not found" });

    // 2️⃣ Отримуємо фото
    const details = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
      params: {
        place_id: placeId,
        fields: "photos,name,geometry",
        key: GOOGLE_API_KEY,
      },
    });

    const photos = details.data.result?.photos || [];
    if (photos.length === 0) {
      return res.status(404).json({ error: "No photos available for this city" });
    }

    // 3️⃣ Формуємо масив об'єктів із розмірами
    const photoData = photos.slice(0, limit).map((p) => ({
      width: p.width || maxwidth,
      height: p.height || maxheight,
      downloadUrl: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxwidth}&photo_reference=${p.photo_reference}&key=${GOOGLE_API_KEY}`,
    }));

    const payload = {
      city,
      total: photoData.length,
      photos: photoData,
      cached: false,
    };

    setCityPhotoCache(city, limit, maxwidth, maxheight, payload);
    setRequestCache("cityphoto", cachePayload, payload);
    res.json(payload);
  } catch (err) {
    console.error("❌ Error fetching city photo:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
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

  const city = req.query.city;
  const limit = Number(req.query.limit || 30);
  const maxwidth = Number(req.query.width || 4000);
  const page = Number(req.query.page || 1);
  const mode = String(req.query.mode || "places").toLowerCase() === "places" ? "places" : "assets";

  if (!city) {
    return res.status(400).json({ error: "city parameter required" });
  }

  if (!UNSPLASH_ACCESS_KEY) {
    console.error("Missing UNSPLASH_ACCESS_KEY");
    return res.status(500).json({ error: "UNSPLASH_ACCESS_KEY not configured" });
  }

  const cachePayload = { city: normalizeCityKey(city), limit, maxwidth, page, mode };
  const cached = getRequestCache("unsplash-photo", cachePayload);
  if (cached) {
    return res.json({ ...cached, cached: true, cache_source: "file" });
  }

  try {
    const response = await axios.get("https://api.unsplash.com/search/photos", {
      params: {
        query: city,
        per_page: Math.min(limit, 30), // Unsplash max is 30 per page
        page,
        ...(mode === "places" ? { orientation: "landscape" } : {}),
        order_by: "relevant",
      },
      headers: {
        Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      },
    });

    const photos = response.data.results.map((photo) => {
      return {
        id: photo.id,
        photographer: photo.user.name,
        username: photo.user.username,
        alt: photo.alt_description || photo.description || city,
        preview: photo.urls.small, // 400px width
        full: `${photo.urls.raw}&w=${maxwidth}&fit=max&q=80`,
        width: photo.width,
        height: photo.height,
        color: photo.color,
        likes: photo.likes,
      };
    });

    const payload = {
      city,
      page,
      count: photos.length,
      total: response.data.total,
      total_pages: response.data.total_pages,
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

app.listen(process.env.PORT, () =>
  console.log(`✅ Google Photo API running on port ${process.env.PORT}`)
);
