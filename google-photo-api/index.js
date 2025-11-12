import express from "express";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();
const app = express();
app.use(express.json());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// GET /cityphoto?city=Bradenton, Florida
app.get("/cityphoto", async (req, res) => {
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: "city parameter required" });

  try {
    // 1️⃣ Знаходимо place_id
    const find = await axios.get("https://maps.googleapis.com/maps/api/place/findplacefromtext/json", {
      params: {
        input: city,
        inputtype: "textquery",
        fields: "place_id",
        key: GOOGLE_API_KEY
      }
    });

    const placeId = find.data.candidates[0]?.place_id;
    if (!placeId) return res.status(404).json({ error: "City not found" });

    // 2️⃣ Отримуємо photo_reference
    const details = await axios.get("https://maps.googleapis.com/maps/api/place/details/json", {
      params: {
        place_id: placeId,
        fields: "photos,name,geometry",
        key: GOOGLE_API_KEY
      }
    });

    const photos = details.data.result?.photos;
    if (!photos || photos.length === 0) {
      return res.status(404).json({ error: "No photos available for this city" });
    }

    // 3️⃣ Формуємо список URL
    const photoUrls = photos.map(
      p =>
        `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1600&photo_reference=${p.photo_reference}&key=${GOOGLE_API_KEY}`
    );

    res.json({
      city,
      total: photoUrls.length,
      photos: photoUrls
    });
  } catch (err) {
    console.error("❌ Error fetching city photo:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(process.env.PORT, () =>
  console.log(`✅ Google Photo API running on port ${process.env.PORT}`)
);
