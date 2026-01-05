import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;


app.get("/pexels-photo", async (req, res) => {
  const city = req.query.city;
  const limit = Number(req.query.limit || 10);
  const maxwidth = Number(req.query.width || 1600);
  const previewWidth = Number(req.query.preview || 600);

  if (!city) {
    return res.status(400).json({ error: "city parameter required" });
  }

  if (!PEXELS_API_KEY) {
    console.error("Missing PEXELS_API_KEY");
    return res.status(500).json({ error: "PEXELS_API_KEY not configured" });
  }

  try {
    const response = await axios.get(
      "https://api.pexels.com/v1/search",
      {
        params: {
          query: city,
          // Pexels limits per_page to a maximum of 80
          per_page: Math.min(limit, 80),
          orientation: "landscape",
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

    res.json({
      city,
      count: photos.length,
      photos,
    });
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

  if (!city) {
    return res.status(400).json({ error: "city parameter required" });
  }

  if (!PIXABAY_API_KEY) {
    console.error("Missing PIXABAY_API_KEY");
    return res.status(500).json({ error: "PIXABAY_API_KEY not configured" });
  }

  try {
    const response = await axios.get("https://pixabay.com/api/", {
      params: {
        key: PIXABAY_API_KEY,
        q: city,
        image_type: "photo",
        orientation: "horizontal",
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

    res.json({
      city,
      page,
      count: photos.length,
      total: response.data.totalHits,
      photos,
    });
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

  if (!city) return res.status(400).json({ error: "city parameter required" });

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

    res.json({
      city,
      total: photoData.length,
      photos: photoData,
    });
  } catch (err) {
    console.error("❌ Error fetching city photo:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
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
