import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import cors from "cors";
import { execSync } from "child_process";
import * as TranslationJobs from "./translation-jobs.js";
import * as BatchTranslation from "./batch-translation.js";

dotenv.config();

const app = express();
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || null; // URL Laravel proxy

// 🔥 Максимально відкритий CORS (все дозволено)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  credentials: false,
}));



app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Origin, X-Requested-With");
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 📁 Папка для збереження зображень
const outputDir = path.join(process.cwd(), "output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Роздаємо статичні файли
app.use("/output", express.static(outputDir));

// 🎯 Мапа підтримуваних розмірів для gpt-image-1.5 (logos/favicons with transparency)
const sizeMap = {
  1: "1024x1024",
  2: "1536x1024",  // landscape
  3: "1024x1536",  // portrait
  4: "1024x1024"   // fallback
};

// 🎯 Мапа розмірів для Qwen Image Plus
// Allowed sizes: 1664*928, 1472*1140, 1328*1328, 1140*1472, 928*1664
const qwenSizeMap = {
  1: "1328*1328",  // square
  2: "1664*928",   // landscape 16:9
  3: "928*1664",   // portrait
  4: "1472*1140"   // landscape 4:3
};


// ================== QWEN IMAGE GENERATION (Alibaba) ==================
app.post("/generate-qwen", authMiddleware, async (req, res) => {
  try {
    const { prompt, n = 4, size = 2 } = req.body; // Default size=2 (16:9 landscape)
    const selectedSize = qwenSizeMap[size] || qwenSizeMap[2];

    // Додаємо до промпту вказівку про горизонтальний формат 3:1 та білий фон
    const enhancedPrompt = `${prompt}. IMPORTANT: Create a horizontal logo without the borders in approximately 3:1 aspect ratio (similar to 1340x450 pixels proportion). Wide horizontal format, not square or vertical. The logo must be placed on a PURE WHITE background (#FFFFFF). DO NOT add any border, frame, outline or decorative edges around the logo. The logo should have without any surrounding frame or border.`;

    console.log(`🧠 [Qwen] Generating "${enhancedPrompt}" with size: ${selectedSize}`);

    const timestamp = Date.now();
    const images = [];

    // Qwen генерує по одному зображенню за раз, тому робимо n запитів паралельно
    const requests = [];
    for (let i = 0; i < n; i++) {
      requests.push(generateQwenImage(enhancedPrompt, selectedSize, i));
    }

    const results = await Promise.allSettled(requests);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        const imageUrl = result.value;
        
        try {
          // Завантажуємо зображення з URL
          const imageResponse = await fetch(imageUrl);
          if (!imageResponse.ok) {
            console.error(`❌ Failed to download image from Qwen URL: ${imageUrl}`);
            continue;
          }
          
          const arrayBuffer = await imageResponse.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const filename = `qwen_${timestamp}_${i + 1}.png`;
          const filepath = path.join(outputDir, filename);
          const tempPath = path.join(outputDir, `temp_${filename}`);

          // Зберігаємо оригінал тимчасово
          fs.writeFileSync(tempPath, buffer);

          // Використовуємо Python rembg для видалення фону
          try {
            execSync(`python3 remove-bg.py "${tempPath}" "${filepath}"`, {
              cwd: process.cwd(),
              stdio: 'inherit'
            });
            console.log(`✅ [Qwen] Background removed for image ${i + 1}`);
          } catch (pythonErr) {
            console.error(`❌ Python rembg failed for image ${i + 1}, falling back to original`);
            fs.writeFileSync(filepath, buffer);
          }

          // Видаляємо тимчасовий файл
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }

          // Trim прозорих країв
          const trimmed = await sharp(filepath).trim().toBuffer();

          // Перезаписуємо PNG з trimmed версією
          fs.writeFileSync(filepath, trimmed);

          // Resize + WebP
          const webpBuffer = await sharp(trimmed)
            .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 90 })
            .toBuffer();

          const webpName = filename.replace(".png", ".webp");
          const webpPath = path.join(outputDir, webpName);
          fs.writeFileSync(webpPath, webpBuffer);

          // Якщо є PROXY_BASE_URL - використовуємо проксі Laravel
          const directUrl = `http://localhost:3005/output/${filename}`;
          const pngUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(directUrl)}` : `https://${req.get("host")}/output/${filename}`;
          const webpDirectUrl = `http://localhost:3005/output/${webpName}`;
          const webpUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(webpDirectUrl)}` : `https://${req.get("host")}/output/${webpName}`;

          images.push({
            index: i + 1,
            png_url: pngUrl,
            webp_url: webpUrl
          });
        } catch (imgErr) {
          console.error(`❌ Failed to process Qwen image ${i + 1}:`, imgErr.message);
        }
      } else {
        console.error(`❌ Qwen request ${i + 1} failed:`, result.reason?.message || result.reason);
      }
    }

    res.json({
      provider: "qwen",
      size: selectedSize,
      count: images.length,
      images
    });
  } catch (err) {
    console.error("❌ Qwen image generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Helper function for Qwen API call
async function generateQwenImage(prompt, size, index) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY not configured");
  }

  const response = await fetch("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "qwen-image-plus",
      input: {
        messages: [
          {
            role: "user",
            content: [
              { text: prompt }
            ]
          }
        ]
      },
      parameters: {
        size: size,
        watermark: false,
        prompt_extend: true,
        negative_prompt: "text, watermark, signature, blurry, low quality, vertical orientation, square format, portrait orientation, frame, border, outline, decorative edges, rounded corners, box, rectangle around logo, framed logo, blur, glow, sparks, sparkles, glitter, particles, lens flare, light effects, soft edges, fuzzy, hazy, gradient background, shadow, reflection, 3d effects, emboss, bevel"
      }
    })
  });

  const data = await response.json();
  
  if (!response.ok || response.status !== 200) {
    console.error(`❌ Qwen API error:`, data);
    throw new Error(data.message || `Qwen API error: ${response.status}`);
  }

  // qwen-image-plus returns image URL directly in output.choices[0].message.content[0].image
  const imageUrl = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
  if (!imageUrl) {
    throw new Error("No image URL returned from Qwen API");
  }

  console.log(`✅ [Qwen] Image ${index + 1} generated`);
  return imageUrl;
}


// ================== IDEOGRAM IMAGE GENERATION ==================
app.post("/generate-ideogram", authMiddleware, async (req, res) => {
  try {
    const { prompt, n = 1, size = 2 } = req.body;

    // Enhanced prompt for logo generation with Ideogram Transparent API
    const enhancedPrompt = `${prompt}. Professional horizontal logo design in wide format. Clean, modern, minimalist style. Vector-style graphics suitable for branding.`;

    console.log(`🎨 [Ideogram Transparent] Generating image with prompt: "${enhancedPrompt}"`);

    const timestamp = Date.now();
    const images = [];

    // Ideogram supports batch generation (num_images: 1-8)
    const envNumImages = parseInt(process.env.IDEOGRAM_NUM_IMAGES) || 1;
    const numImages = Math.min(Math.max(envNumImages, 1), 8);

    const apiKey = process.env.IDEOGRAM_API_KEY;
    if (!apiKey) {
      throw new Error("IDEOGRAM_API_KEY not configured");
    }

    // Build JSON body for transparent generation
    const requestBody = {
      prompt: enhancedPrompt,
      aspect_ratio: '3x1',
      num_images: numImages,
      rendering_speed: 'TURBO',
      magic_prompt: 'AUTO',
    };

    const response = await fetch("https://api.ideogram.ai/v1/ideogram-v3/generate-transparent", {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`❌ Ideogram API error:`, data);
      throw new Error(data.error?.message || `Ideogram API error: ${response.status}`);
    }

    if (!data.data || data.data.length === 0) {
      throw new Error("No images returned from Ideogram API");
    }

    // Process each generated image
    for (let i = 0; i < data.data.length; i++) {
      const imageData = data.data[i];
      const imageUrl = imageData.url;

      if (!imageUrl) {
        console.warn(`⚠️ [Ideogram] No URL for image ${i + 1}`);
        continue;
      }

      try {
        // Download image from Ideogram URL
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
          console.error(`❌ Failed to download image from Ideogram URL: ${imageUrl}`);
          continue;
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const filename = `ideogram_${timestamp}_${i + 1}.png`;
        const filepath = path.join(outputDir, filename);

        // Transparent API returns PNG with alpha channel — save directly, no rembg needed
        fs.writeFileSync(filepath, buffer);
        console.log(`✅ [Ideogram Transparent] Image ${i + 1} saved (native transparency)`);

        // Trim transparent edges
        const trimmed = await sharp(filepath).trim().toBuffer();
        fs.writeFileSync(filepath, trimmed);

        // Resize + WebP conversion
        const webpBuffer = await sharp(trimmed)
          .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();

        const webpName = filename.replace(".png", ".webp");
        const webpPath = path.join(outputDir, webpName);
        fs.writeFileSync(webpPath, webpBuffer);

        // Build URLs
        const directUrl = `http://localhost:3005/output/${filename}`;
        const pngUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(directUrl)}` : `https://${req.get("host")}/output/${filename}`;
        const webpDirectUrl = `http://localhost:3005/output/${webpName}`;
        const webpUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(webpDirectUrl)}` : `https://${req.get("host")}/output/${webpName}`;

        images.push({
          index: i + 1,
          url: pngUrl,
          webp_url: webpUrl,
          seed: imageData.seed,
          style_type: imageData.style_type
        });

        console.log(`✅ [Ideogram] Image ${i + 1} processed`);
      } catch (imgErr) {
        console.error(`❌ [Ideogram] Error processing image ${i + 1}:`, imgErr);
      }
    }

    console.log(`🎉 [Ideogram] Generation complete: ${images.length}/${numImages} images`);

    res.json({
      provider: "ideogram",
      count: images.length,
      images
    });

  } catch (err) {
    console.error("❌ Ideogram image generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// === FAVICON PREVIEW - returns original AI image without processing ===
app.post("/generate-favicon-preview", authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 [OpenAI] Generating favicon preview: "${prompt}"`);

    // Генеруємо з прозорим фоном для кращого результату
    const result = await openai.images.generate({
      model: "gpt-image-1.5",
      prompt: `${prompt}, centered icon on transparent background, no text, professional app icon`,
      n: 1,
      quality: "low",
      size: "1024x1024",
      background: "transparent",
      output_format: "png",
    });

    const item = result.data[0];
    if (!item.b64_json) throw new Error("No image data returned.");

    console.log("✅ [OpenAI] Favicon preview generated");

    // Повертаємо оригінал без обробки
    res.json({
      success: true,
      original_base64: item.b64_json,
    });

  } catch (err) {
    console.error("❌ [OpenAI] Favicon preview failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === QWEN FAVICON PREVIEW - returns original AI image without processing ===
app.post("/generate-favicon-preview-qwen", authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 [Qwen] Generating favicon preview: "${prompt}"`);

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error("DASHSCOPE_API_KEY not configured");

    const response = await fetch("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen-image-plus",
        input: {
          messages: [{
            role: "user",
            content: [{ text: `${prompt}, centered icon on clean white background, no text, professional app icon, square 1:1` }]
          }]
        },
        parameters: {
          size: "1024*1024",
          watermark: false,
          prompt_extend: true,
          negative_prompt: "text, watermark, signature, blurry"
        }
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `Qwen API error: ${response.status}`);

    const imageUrl = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
    if (!imageUrl) throw new Error("No image URL returned from Qwen API");

    // Завантажуємо зображення і конвертуємо в base64
    const imageRes = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    console.log("✅ [Qwen] Favicon preview generated");

    res.json({
      success: true,
      original_base64: imageBuffer.toString("base64"),
    });

  } catch (err) {
    console.error("❌ [Qwen] Favicon preview failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === IDEOGRAM FAVICON PREVIEW - returns original AI image without processing ===
app.post("/generate-favicon-preview-ideogram", authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 [Ideogram] Generating favicon preview: "${prompt}"`);

    const apiKey = process.env.IDEOGRAM_API_KEY;
    if (!apiKey) {
      throw new Error("IDEOGRAM_API_KEY not configured");
    }

    const strictPrompt = [
      prompt,
      "Create ONE square app icon composition.",
      "No text, no letters, no words, no typography.",
      "Centered symbol only, clean minimal icon, white or transparent style background.",
      "Do not create horizontal logo layout."
    ].join(" ");

    const formData = new FormData();
    formData.append("prompt", strictPrompt);
    formData.append("aspect_ratio", "1x1");
    formData.append("num_images", "1");
    formData.append("rendering_speed", "TURBO");
    formData.append("magic_prompt", "OFF");

    const response = await fetch("https://api.ideogram.ai/v1/ideogram-v3/generate", {
      method: "POST",
      headers: {
        "Api-Key": apiKey
      },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("❌ [Ideogram] Favicon API error:", data);
      throw new Error(data?.error?.message || `Ideogram API error: ${response.status}`);
    }

    const imageUrl = data?.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error("No image URL returned from Ideogram favicon API");
    }

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error(`Failed to download Ideogram favicon image: ${imageRes.status}`);
    }

    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    console.log("✅ [Ideogram] Favicon preview generated");
    res.json({
      success: true,
      original_base64: imageBuffer.toString("base64"),
    });
  } catch (err) {
    console.error("❌ [Ideogram] Favicon preview failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === PROCESS FAVICON - remove white background, crop, generate PWA icons ===
app.post("/process-favicon", authMiddleware, async (req, res) => {
  try {
    const { image_base64 } = req.body;
    if (!image_base64) throw new Error("No image_base64 provided");

    console.log("🔧 Processing favicon - removing background...");

    const sharp = (await import("sharp")).default;
    const buffer = Buffer.from(image_base64, "base64");

    // 1️⃣ Отримуємо метадані
    const meta = await sharp(buffer).metadata();
    const { width, height } = meta;

    // 2️⃣ Видаляємо білий/світлий фон (робимо прозорим)
    // Конвертуємо в raw pixels, замінюємо білі пікселі на прозорі
    const { data: rawData, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(rawData);
    const threshold = 240; // Пікселі світліші за це стають прозорими

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      
      // Якщо піксель білий/майже білий - робимо прозорим
      if (r > threshold && g > threshold && b > threshold) {
        pixels[i + 3] = 0; // alpha = 0
      }
    }

    const transparentBuffer = await sharp(Buffer.from(pixels), {
      raw: { width: info.width, height: info.height, channels: 4 }
    }).png().toBuffer();

    // 3️⃣ Тримаємо пусті області
    const trimmed = await sharp(transparentBuffer)
      .trim({ threshold: 10 })
      .toBuffer();

    const trimMeta = await sharp(trimmed).metadata();
    const maxSize = Math.max(trimMeta.width || 100, trimMeta.height || 100);

    // 4️⃣ Центруємо на квадратному прозорому полотні
    const squared = await sharp({
      create: {
        width: maxSize,
        height: maxSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{
        input: trimmed,
        top: Math.floor((maxSize - (trimMeta.height || 100)) / 2),
        left: Math.floor((maxSize - (trimMeta.width || 100)) / 2)
      }])
      .png()
      .toBuffer();

    // 5️⃣ Фавікон 64×64
    const favicon64 = await sharp(squared)
      .resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // 6️⃣ PWA sizes
    const pwaSizes = [192, 256, 384, 512];
    const pwaIcons = {};
    
    for (const size of pwaSizes) {
      const img = await sharp(squared)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      pwaIcons[size] = img.toString("base64");
    }

    console.log("✅ Favicon processed successfully");

    res.json({
      success: true,
      favicon_base64: favicon64.toString("base64"),
      pwa_icons: pwaIcons,
    });

  } catch (err) {
    console.error("❌ Favicon processing failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy endpoints for backwards compatibility
app.post("/generate-favicon", authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 Generating favicon: "${prompt}"`);

    // 1️⃣ Генеруємо 1024×1024 з прозорим фоном (альфа канал)
    const result = await openai.images.generate({
      model: "gpt-image-1.5",
      prompt: `${prompt}, centered object, transparent background, no text`,
      n: 1,
      quality: "low",
      size: "1024x1024",
      background: "transparent",
      output_format: "png",
    });

    const item = result.data[0];
    if (!item.b64_json) throw new Error("No image data returned.");

    const sharp = (await import("sharp")).default;
    const buffer = Buffer.from(item.b64_json, "base64");

    // 2️⃣ метадані для обрізки
    const meta = await sharp(buffer).metadata();
    const { width, height } = meta;

    // 3️⃣ обрізаємо 10% зліва/справа
    const cropMargin = Math.round(width * 0.1);
    const cropped = await sharp(buffer)
      .extract({
        left: cropMargin,
        top: 0,
        width: width - cropMargin * 2,
        height: height,
      })
      .toBuffer();

    // 4️⃣ створюємо квадратне полотно 1024×1024
    const canvasSize = 1024;
    const canvas = await sharp({
      create: {
        width: canvasSize,
        height: canvasSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: cropped,
          top: 0,
          left: Math.floor(
            (canvasSize - (width - cropMargin * 2)) / 2
          ),
        },
      ])
      .png()
      .toBuffer();

    const trimmedCanvas = await sharp(canvas).trim().toBuffer();      
    const { width: tw, height: th } = await sharp(trimmedCanvas).metadata();
    const maxSize = Math.max(tw, th);

    const squared = await sharp({
      create: {
        width: maxSize,
        height: maxSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }
    })
      .composite([
        {
          input: trimmedCanvas,
          top: Math.floor((maxSize - th) / 2),
          left: Math.floor((maxSize - tw) / 2),
        },
      ])
      .png()
      .toBuffer();    
    // 5️⃣ Фавікон 64×64
    const favicon64 = await sharp(squared)
      .resize(64, 64, { fit: "cover" })
      .png({ quality: 95 })
      .toBuffer();

    // 6️⃣ PWA sizes
    const pwaSizes = [192, 256, 384, 512];

    async function makePWAs() {
      const out = {};
      for (const size of pwaSizes) {
      const img = await sharp(squared)
        .resize(size, size)
        .png({ quality: 95 })
        .toBuffer();

        out[size] = img.toString("base64");
      }
      return out;
    }

    const pwaIcons = await makePWAs();

    // 7️⃣ Response JSON
    res.json({
      success: true,
      favicon_base64: favicon64.toString("base64"),
      pwa_icons: pwaIcons,
    });

  } catch (err) {
    console.error("❌ Favicon generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// === QWEN FAVICON GENERATION (1:1 square) ===
app.post("/generate-favicon-qwen", authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 [Qwen] Generating favicon: "${prompt}"`);

    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error("DASHSCOPE_API_KEY not configured");
    }

    // 1️⃣ Генеруємо 1024×1024 квадратне зображення через Qwen
    const response = await fetch("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen-image-plus",
        input: {
          messages: [
            {
              role: "user",
              content: [
                { text: `${prompt}, centered object, clean background, no text, square format 1:1` }
              ]
            }
          ]
        },
        parameters: {
          size: "1024*1024",
          watermark: false,
          prompt_extend: true,
          negative_prompt: "text, watermark, signature, blurry, low quality, frame, border"
        }
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || `Qwen API error: ${response.status}`);
    }

    const imageUrl = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image;
    if (!imageUrl) {
      throw new Error("No image URL returned from Qwen API");
    }

    // 2️⃣ Завантажуємо зображення
    const imageRes = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    const sharp = (await import("sharp")).default;

    // 3️⃣ Обробляємо зображення - робимо квадратним та тримаємо
    const meta = await sharp(imageBuffer).metadata();
    const { width, height } = meta;

    // Обрізаємо до квадрата якщо потрібно
    const minSize = Math.min(width, height);
    const left = Math.floor((width - minSize) / 2);
    const top = Math.floor((height - minSize) / 2);

    const squared = await sharp(imageBuffer)
      .extract({ left, top, width: minSize, height: minSize })
      .resize(1024, 1024)
      .png()
      .toBuffer();

    // 4️⃣ Тримаємо пусті області
    const trimmed = await sharp(squared).trim().toBuffer();
    const trimMeta = await sharp(trimmed).metadata();
    const maxTrimSize = Math.max(trimMeta.width, trimMeta.height);

    // Центруємо на квадратному полотні
    const finalSquare = await sharp({
      create: {
        width: maxTrimSize,
        height: maxTrimSize,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 }
      }
    })
      .composite([{
        input: trimmed,
        top: Math.floor((maxTrimSize - trimMeta.height) / 2),
        left: Math.floor((maxTrimSize - trimMeta.width) / 2)
      }])
      .png()
      .toBuffer();

    // 5️⃣ Фавікон 64×64
    const favicon64 = await sharp(finalSquare)
      .resize(64, 64, { fit: "cover" })
      .png({ quality: 95 })
      .toBuffer();

    // 6️⃣ PWA sizes
    const pwaSizes = [192, 256, 384, 512];
    const pwaIcons = {};
    
    for (const size of pwaSizes) {
      const img = await sharp(finalSquare)
        .resize(size, size)
        .png({ quality: 95 })
        .toBuffer();
      pwaIcons[size] = img.toString("base64");
    }

    // 7️⃣ Response JSON
    res.json({
      success: true,
      favicon_base64: favicon64.toString("base64"),
      pwa_icons: pwaIcons,
    });

    console.log("✅ [Qwen] Favicon generated successfully");

  } catch (err) {
    console.error("❌ [Qwen] Favicon generation failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post("/generate", authMiddleware, async (req, res) => {
  try {
    const { prompt, n = 4, size = 2 } = req.body; // Default size=2 (16:9 landscape)
    const selectedSize = sizeMap[size] || sizeMap[2];

    // Додаємо до промпту вказівку про горизонтальний формат 3:1 з прозорим фоном
    const enhancedPrompt = `${prompt}. IMPORTANT: Create a horizontal logo in approximately 3:1 aspect ratio (similar to 1340x450 pixels proportion). Wide horizontal format, not square or vertical. DO NOT add any border, frame, outline or decorative edges around the logo. Clean sharp edges. Transparent background, no background.`;

    console.log(`🧠 Generating ${n} images with prompt: "${enhancedPrompt}" and size: ${selectedSize}`);

    const result = await openai.images.generate({
      model: "gpt-image-1.5",
      prompt: enhancedPrompt,
      n,
      quality: "low",
      size: selectedSize,
      background: "transparent",
      output_format: "png",
    });

    const timestamp = Date.now();
    const images = [];

    for (let index = 0; index < result.data.length; index++) {
      const item = result.data[index];
      if (!item.b64_json) continue;

      const buffer = Buffer.from(item.b64_json, "base64");
      const filename = `image_${timestamp}_${index + 1}.png`;
      const filepath = path.join(outputDir, filename);

      // 🧩 Trim
      const trimmed = await sharp(buffer).trim().toBuffer();

      // 💾 Save trimmed PNG
      fs.writeFileSync(filepath, trimmed);

      // 🧠 Resize + convert to WebP
      const webpBuffer = await sharp(trimmed)
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer();

      const webpName = filename.replace(".png", ".webp");
      const webpPath = path.join(outputDir, webpName);
      fs.writeFileSync(webpPath, webpBuffer);

      // Якщо є PROXY_BASE_URL - використовуємо проксі Laravel
      const directUrl = `http://localhost:3005/output/${filename}`;
      const pngUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(directUrl)}` : `https://${req.get("host")}/output/${filename}`;
      const webpDirectUrl = `http://localhost:3005/output/${webpName}`;
      const webpUrl = PROXY_BASE_URL ? `${PROXY_BASE_URL}/api/proxy-image?url=${encodeURIComponent(webpDirectUrl)}` : `https://${req.get("host")}/output/${webpName}`;

      images.push({
        index: index + 1,
        png_url: pngUrl,
        webp_url: webpUrl
      });
    }

    console.log(`🎉 Generation complete: ${images.length}/${n} images succeeded`);

    res.json({
      size: selectedSize,
      count: images.length,
      images
    });
  } catch (err) {
    console.error("❌ Image generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/text", authMiddleware, async (req, res) => {
  await handleTextGeneration(req, res, null);
});

app.post("/text/openai", authMiddleware, async (req, res) => {
  await handleTextGeneration(req, res, "openai");
});

app.post("/text/anthropic", authMiddleware, async (req, res) => {
  await handleTextGeneration(req, res, "anthropic");
});

app.post("/text/web-search", authMiddleware, async (req, res) => {
  await handleTextWebSearch(req, res);
});

app.post("/text/openai/web-search", authMiddleware, async (req, res) => {
  await handleTextWebSearch(req, res);
});

async function handleTextGeneration(req, res, forcedProvider = null) {
  try {
    console.log("🧠 Text generation request received.");
    const {
      prompt,
      format = "",
      max_tokens = 10096,
      temperature = 0.9,
      provider = "openai",
      model = ""
    } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const maxTokens = Math.min(parseInt(max_tokens, 10) || 10096, 16000);

    const systemMessage =
      "You are an assistant that always replies in a clear, direct and concise way without explanations or extra commentary. " +
      "If the user requests HTML, return ONLY the raw HTML (no surrounding text, no code fences, no comments). " +
      "Always follow the user's requested format exactly.";

    const wantsHtml = (String(format).toLowerCase() === "html");
    const userMessage =
      prompt +
      "\n\nIMPORTANT: reply clearly and directly with no explanations. " +
      (wantsHtml ? "Return ONLY the HTML and nothing else." : "");

    const providerCandidate = (forcedProvider || provider || "openai");
    const normalizedProvider = String(providerCandidate).toLowerCase();
    const providerUsed = (normalizedProvider === "anthropic" || normalizedProvider === "claude") ? "anthropic" : "openai";
    let finalProviderUsed = providerUsed;
    const openAiModel = resolveOpenAIModel(model, process.env.OPENAI_MODEL_CHEAP || "gpt-4o-mini");
    let modelUsed = providerUsed === "anthropic"
      ? (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5")
      : openAiModel;

    let content = "";
    if (providerUsed === "anthropic") {
      console.log("🧠 /text using provider=anthropic model=", modelUsed);
      content = await generateTextWithAnthropic({
        systemMessage,
        userMessage,
        maxTokens,
        temperature,
      });
    } else {
      console.log(`🧠 /text using provider=openai model=${openAiModel}`);
      try {
        const completion = await openai.chat.completions.create({
          model: openAiModel,
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: userMessage }
          ],
          max_completion_tokens: maxTokens,
          top_p: 1,
        });

        content =
          completion?.choices?.[0]?.message?.content ??
          completion?.choices?.[0]?.text ??
          "";
      } catch (err) {
        if (isOpenAIQuotaOrRateLimitError(err) && canFallbackToAnthropic()) {
          console.warn("⚠️ OpenAI quota/rate limit on /text. Falling back to Anthropic.");
          content = await generateTextWithAnthropic({
            systemMessage,
            userMessage,
            maxTokens,
            temperature,
          });
          finalProviderUsed = "anthropic";
          modelUsed = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
        } else {
          throw err;
        }
      }
    }

    res.json({ text: content, provider_used: finalProviderUsed, model_used: modelUsed });
  } catch (err) {
    console.error("❌ Text generation failed:", err);
    res.status(500).json({ error: err.message });
  }
}

async function handleTextWebSearch(req, res) {
  try {
    console.log("🌐 Web search text generation request received.");
    const {
      prompt,
      max_tokens = 8192,
      model = "",
    } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const maxTokens = Math.min(parseInt(max_tokens, 10) || 8192, 12000);
    const openAiModel = resolveOpenAIModel(model, process.env.OPENAI_MODEL_QUALITY || "gpt-4o-mini");
    const input = [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are a research assistant that uses web search when current or factual web grounding improves the answer. Return exactly what the user asks for and preserve strict JSON-only response requirements when requested."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt
          }
        ]
      }
    ];

    const searchResponse = await openai.responses.create({
      model: openAiModel,
      input,
      tools: [{
        type: "web_search",
        external_web_access: true,
      }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      max_output_tokens: maxTokens,
      reasoning: {
        effort: openAiModel === "gpt-5-nano" ? "low" : "medium",
      },
    });

    const researchText = searchResponse?.output_text || extractResponseOutputText(searchResponse);
    const metadata = extractWebSearchMetadata(searchResponse);

    const structuringResponse = await openai.responses.create({
      model: openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You convert grounded research notes into strict JSON. Return only valid JSON with no markdown and no extra text. Preserve the exact schema requested by the user."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n\nGrounded research notes:\n${researchText}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
      max_output_tokens: Math.min(maxTokens, 6000),
    });

    const text = structuringResponse?.output_text || extractResponseOutputText(structuringResponse);

    res.json({
      text,
      provider_used: "openai",
      model_used: openAiModel,
      response_id: searchResponse?.id || null,
      structuring_response_id: structuringResponse?.id || null,
      web_search_call_id: metadata.webSearchCallId,
      sources: metadata.sources,
    });
  } catch (err) {
    console.error("❌ Web search text generation failed:", err);
    res.status(500).json({ error: err.message });
  }
}

app.get("/text-provider-status", authMiddleware, async (req, res) => {
  try {
    const openaiStatus = await getOpenAIStatus();
    const anthropicStatus = await getAnthropicStatus();

    res.json({
      success: true,
      providers: {
        openai: openaiStatus,
        anthropic: anthropicStatus,
      },
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Provider status failed:", err);
    res.status(500).json({ success: false, error: err.message || "provider status failed" });
  }
});

async function generateTextWithAnthropic({ systemMessage, userMessage, maxTokens, temperature }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      system: systemMessage,
      max_tokens: Math.min(Math.max(parseInt(maxTokens, 10) || 4096, 256), 8192),
      temperature: Math.max(0, Math.min(Number(temperature ?? 0.7), 1)),
      messages: [
        {
          role: "user",
          content: userMessage
        }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `Anthropic API error: ${response.status}`);
  }

  const firstText = data?.content?.find(item => item?.type === "text")?.text;
  return firstText || "";
}

function extractResponseOutputText(response) {
  const output = Array.isArray(response?.output) ? response.output : [];

  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) {
      continue;
    }

    const textBlock = item.content.find((content) => content?.type === "output_text" && typeof content?.text === "string");
    if (textBlock?.text) {
      return textBlock.text;
    }
  }

  return "";
}

function extractWebSearchMetadata(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const sourceMap = new Map();
  let webSearchCallId = null;

  for (const item of output) {
    if (item?.type === "web_search_call") {
      webSearchCallId = webSearchCallId || item?.id || null;

      const sources = item?.action?.sources;
      if (Array.isArray(sources)) {
        for (const source of sources) {
          const url = String(source?.url || source?.uri || "").trim();
          if (!url) continue;
          sourceMap.set(url, {
            url,
            title: String(source?.title || "").trim() || url,
          });
        }
      }
    }

    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const block of item.content) {
        const annotations = Array.isArray(block?.annotations) ? block.annotations : [];
        for (const annotation of annotations) {
          if (annotation?.type !== "url_citation") {
            continue;
          }

          const url = String(annotation?.url || "").trim();
          if (!url) continue;
          sourceMap.set(url, {
            url,
            title: String(annotation?.title || "").trim() || url,
          });
        }
      }
    }
  }

  return {
    webSearchCallId,
    sources: Array.from(sourceMap.values()),
  };
}

function canFallbackToAnthropic() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function isOpenAIQuotaOrRateLimitError(err) {
  const status = Number(
    err?.status ||
    err?.response?.status ||
    err?.cause?.status ||
    0
  );

  const message = String(
    err?.message ||
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    ""
  ).toLowerCase();

  return (
    status === 429 ||
    message.includes("insufficient_quota") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("billing")
  );
}

function resolveOpenAIModel(requestedModel, fallbackModel = "gpt-4o-mini") {
  const cheapDefault = process.env.OPENAI_MODEL_CHEAP || "gpt-4o-mini";
  const qualityDefault = process.env.OPENAI_MODEL_QUALITY || fallbackModel || "gpt-4o-mini";
  const raw = String(requestedModel || "").toLowerCase().trim();

  if (!raw) {
    return qualityDefault;
  }

  if (raw === "cheap" || raw === "openai-cheap") {
    return cheapDefault;
  }

  if (raw === "quality" || raw === "openai-quality" || raw === "pro") {
    return qualityDefault;
  }

  const allowed = new Set([
    "gpt-5-nano",
    "gpt-4o-mini",
    "gpt-5.1",
  ]);

  if (raw === "gpt-5-mini" || raw === "gpt-5.4" || raw === "gpt-4.1-mini" || raw === "gpt-5" || raw === "gpt-5.4-mini") {
    return "gpt-4o-mini";
  }

  return allowed.has(raw) ? raw : qualityDefault;
}

async function getOpenAIStatus() {
  const runtimeKey = process.env.OPENAI_API_KEY;
  const balanceKey = process.env.OPENAI_BALANCE_TOKEN || "";

  if (!runtimeKey && !balanceKey) {
    return {
      configured: false,
      available: false,
      balance: { display: "unavailable (no keys)", value: null, currency: null, source: "none" },
    };
  }

  let available = false;
  try {
    if (runtimeKey) {
      const modelProbe = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${runtimeKey}` }
      });
      available = modelProbe.ok;
    }
  } catch (_) {
    available = false;
  }

  let balanceDisplay = balanceKey ? "unavailable via API" : "unavailable (no balance token)";
  let balanceValue = null;
  let balanceCurrency = "USD";
  let balanceSource = balanceKey ? "unavailable" : "missing_balance_token";

  if (balanceKey) {
    try {
      // Use /v1/organization/costs?bucket_width=1d&limit=30 to sum recent spend.
      // credit_grants is browser-only and returns 403 for admin/secret keys.
      const start30d = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
      const costsRes = await fetch(
        `https://api.openai.com/v1/organization/costs?start_time=${start30d}&bucket_width=1d&limit=30`,
        { headers: { Authorization: `Bearer ${balanceKey}` } }
      );

      if (costsRes.ok) {
        const costsData = await costsRes.json();
        const results = costsData?.data ?? costsData?.results ?? [];
        let totalSpent = 0;
        for (const bucket of results) {
          const amt = bucket?.results?.[0]?.amount?.value ?? bucket?.amount?.value ?? 0;
          totalSpent += Number(amt) || 0;
        }
        // Convert from cents to dollars if needed (API returns dollars)
        balanceValue = totalSpent;
        balanceDisplay = `Spent $${totalSpent.toFixed(2)} (30d)`;
        balanceCurrency = "USD";
        balanceSource = "openai_org_costs_30d";
      }
    } catch (_) {
      // Ignore and keep unavailable state.
    }
  }

  return {
    configured: Boolean(runtimeKey),
    available,
    balance: {
      display: balanceDisplay,
      value: balanceValue,
      currency: balanceCurrency,
      source: balanceSource,
    },
  };
}

async function getAnthropicStatus() {
  const runtimeKey = process.env.ANTHROPIC_API_KEY;
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY || "";

  if (!runtimeKey && !adminKey) {
    return {
      configured: false,
      available: false,
      balance: { display: "unavailable (no key)", value: null, currency: null, source: "none" },
    };
  }

  let available = false;
  try {
    // Runtime connectivity check for Claude message generation.
    if (!runtimeKey) {
      available = false;
    } else {
    const probe = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": runtimeKey,
        "anthropic-version": "2023-06-01"
      }
    });
    available = probe.ok;
    }
  } catch (_) {
    available = false;
  }

  // Usage/Cost API requires an Admin API key (sk-ant-admin...).
  let balanceDisplay = "unavailable via API";
  let balanceValue = null;
  let balanceSource = "not_exposed";

  if (!adminKey) {
    balanceDisplay = "needs ANTHROPIC_ADMIN_API_KEY";
    balanceSource = "missing_admin_key";
  } else if (!adminKey.startsWith("sk-ant-admin")) {
    balanceDisplay = "admin key required (sk-ant-admin...)";
    balanceSource = "invalid_admin_key_type";
  } else {
    try {
      const range = getUtcDayRange(7);
      const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
      url.searchParams.set("starting_at", range.startingAt);
      url.searchParams.set("ending_at", range.endingAt);
      url.searchParams.append("group_by[]", "description");

      const costRes = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-api-key": adminKey,
          "anthropic-version": "2023-06-01",
          "User-Agent": "rental-project/1.0"
        }
      });

      if (costRes.ok) {
        const costData = await costRes.json();
        const usdMinor = extractUsdMinorUnits(costData);
        if (usdMinor !== null) {
          balanceValue = Number((usdMinor / 100).toFixed(2));
          balanceDisplay = `$${balanceValue.toFixed(2)} spent (last 7d)`;
          balanceSource = "anthropic_cost_report";
        } else {
          balanceDisplay = "no cost data yet";
          balanceSource = "anthropic_cost_report_empty";
        }
      } else if (costRes.status === 401 || costRes.status === 403) {
        balanceDisplay = "admin key rejected";
        balanceSource = "anthropic_admin_auth_failed";
      } else {
        balanceDisplay = `cost API error (${costRes.status})`;
        balanceSource = "anthropic_cost_report_error";
      }
    } catch (_) {
      balanceDisplay = "cost API unavailable";
      balanceSource = "anthropic_cost_report_unreachable";
    }
  }

  return {
    configured: Boolean(runtimeKey),
    available,
    balance: {
      display: balanceDisplay,
      value: balanceValue,
      currency: "USD",
      source: balanceSource,
    },
  };
}

function getUtcDayRange(daysBack = 7) {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, daysBack));

  return {
    startingAt: start.toISOString().replace(".000", ""),
    endingAt: end.toISOString().replace(".000", ""),
  };
}

function extractUsdMinorUnits(costData) {
  const buckets = Array.isArray(costData?.data) ? costData.data : [];
  let totalMinor = 0;
  let found = false;

  for (const bucket of buckets) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const row of results) {
      const amount = row?.amount || row?.cost || row?.total_cost || null;
      if (!amount || String(amount.currency || "").toUpperCase() !== "USD") {
        continue;
      }

      const minor = Number(amount.value);
      if (Number.isFinite(minor)) {
        totalMinor += minor;
        found = true;
      }
    }
  }

  return found ? totalMinor : null;
}


// ============================================================================
// TRANSLATION JOB SYSTEM - Persistent, resumable, with progress tracking
// ============================================================================

// Language code to full name mapping for better AI translation
const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'nl': 'Dutch',
  'pl': 'Polish',
  'ru': 'Russian',
  'uk': 'Ukrainian',
  'tr': 'Turkish',
  'ar': 'Arabic',
  'he': 'Hebrew',
  'zh': 'Chinese (Simplified)',
  'ja': 'Japanese',
  'ko': 'Korean',
  'hi': 'Hindi',
  'bn': 'Bengali',
  'ur': 'Urdu',
  'th': 'Thai',
  'vi': 'Vietnamese',
  'id': 'Indonesian',
  'ms': 'Malay',
  'tl': 'Filipino (Tagalog)',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'el': 'Greek',
  'cs': 'Czech',
  'ro': 'Romanian',
  'hu': 'Hungarian',
  'hr': 'Croatian',
  'bg': 'Bulgarian',
  'sk': 'Slovak',
  'sr': 'Serbian',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'et': 'Estonian',
  'sl': 'Slovenian',
  'ca': 'Catalan',
  'eu': 'Basque',
  'is': 'Icelandic',
  'mt': 'Maltese',
  'sq': 'Albanian',
  'ka': 'Georgian',
};

const getLanguageName = (code) => LANGUAGE_NAMES[code] || code;

const TRANSLATION_SYSTEM_MESSAGE = (lang) => {
  const languageName = getLanguageName(lang);
  return `
You are a professional website translator and content editor specializing in Laravel Blade templates.
The website content is related to car rental services (booking, pricing, fleet, airport rentals, insurance, deals, locations, etc.).

Your task is to translate all visible, human-readable text into ${languageName} (language code: ${lang}), but you are NOT limited to literal translation:
- You may paraphrase, restructure sentences, or rewrite the meaning when necessary.
- If a direct translation sounds unnatural, awkward, too literal, or unclear — rewrite it so it reads naturally for a native speaker.
- Improve clarity, flow, tone, and readability, while maintaining the original intention.

STRICT PRESERVATION RULES (DO NOT MODIFY ANY OF THESE):
- DO NOT change, rewrite, translate, or alter ANY URLs, links, image sources, asset paths, filenames, folders, or file extensions (jpg/png/webp/css/js/svg).
- DO NOT change strings inside /assets/..., /images/..., /css/..., /js/..., or any other static resource paths.
- DO NOT modify JavaScript, CSS, Blade directives (@if, @foreach, @extends, etc.), variables ({{ }}, {!! !!}), comments, inline styles, classes, indentation, or HTML structure.
- DO NOT touch technical strings, slugs, SEO keywords inside URLs, or dynamic parameters.

TRANSLATE ONLY:
- Human-visible text content inside HTML tags.
- Ignore alt attributes of images if they contain slugs or filenames.

OUTPUT RULES:
- Output ONLY the translated Blade template (no explanations, notes, markdown, or commentary).
- Structure and formatting must remain 100% identical to the input.
`;
};

// Active processing flags to prevent duplicate processing
const activeProcessing = new Set();

// Start a new translation job
app.post("/translate-job-start", authMiddleware, async (req, res) => {
  try {
    const { siteId, domain, files, batchSize } = req.body;

    if (!siteId || !domain || !files || !Array.isArray(files)) {
      return res.status(400).json({
        error: "Required: siteId, domain, files[]",
      });
    }

    // Check for existing active job
    const existingJob = TranslationJobs.getActiveJobForSite(siteId);
    if (existingJob) {
      return res.json({
        success: true,
        job: TranslationJobs.getJobSummary(existingJob.id),
        message: "Existing active job found",
      });
    }

    // Create new job with optional batch size (default 50)
    const job = TranslationJobs.createJob(siteId, domain, files, batchSize || 50);
    console.log(`🚀 [translate-job-start] Job ${job.id} created: ${domain}, ${files.length} files, batchSize: ${batchSize || 50}`);

    // Start processing in background
    processJob(job.id);

    res.json({
      success: true,
      job: TranslationJobs.getJobSummary(job.id),
      message: "Job created and started",
    });
  } catch (err) {
    console.error("❌ [translate-job-start] Failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get job status
app.get("/translate-job-status/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const job = TranslationJobs.getJobSummary(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({ success: true, job });
  } catch (err) {
    console.error("❌ Failed to get job status:", err);
    res.status(500).json({ error: err.message });
  }
});

// Add content to queued files
app.post("/translate-job-add-content/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const { files } = req.body;

    console.log(`📥 [Container] /translate-job-add-content called - jobId: ${jobId}, files: ${files?.length || 0}`);

    if (!files || !Array.isArray(files)) {
      console.error(`❌ [Container] Invalid request - files not array`);
      return res.status(400).json({ error: "Required: files[]" });
    }

    const result = TranslationJobs.addContentToFiles(jobId, files);

    if (!result) {
      console.error(`❌ [Container] Job not found: ${jobId}`);
      return res.status(404).json({ error: "Job not found" });
    }

    console.log(`✅ [Container] Added content for ${result.added} files`);

    res.json({ 
      success: true, 
      added: result.added,
      job: TranslationJobs.getJobSummary(jobId),
    });
  } catch (err) {
    console.error("❌ [Container] Failed to add content:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get files that need content (queued files)
app.get("/translate-job-need-content/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    console.log(`🔍 [Container] /translate-job-need-content called - jobId: ${jobId}, limit: ${limit}`);
    
    const files = TranslationJobs.getFilesNeedingContent(jobId, limit);
    const queuedCount = TranslationJobs.getQueuedFilesCount(jobId);

    console.log(`📋 [Container] Found ${files.length} files needing content, ${queuedCount} total queued`);

    res.json({ 
      success: true, 
      files,
      queuedCount,
    });
  } catch (err) {
    console.error("❌ [Container] Failed to get files needing content:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get active job for site
app.get("/translate-job-active/:siteId", authMiddleware, (req, res) => {
  try {
    const { siteId } = req.params;
    const job = TranslationJobs.getActiveJobForSite(siteId);

    if (!job) {
      return res.json({ success: true, job: null });
    }

    res.json({ success: true, job: TranslationJobs.getJobSummary(job.id) });
  } catch (err) {
    console.error("❌ Failed to get active job:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stop job
app.post("/translate-job-stop/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🛑 [translate-job-stop] Stopping job ${jobId}`);
    const job = TranslationJobs.stopJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Remove from active processing
    activeProcessing.delete(jobId);
    const pending = job.files.filter(f => f.status === 'pending' || f.status === 'processing').length;
    console.log(`🛑 [translate-job-stop] Job ${jobId} stopped. ${pending} files were pending/processing`);

    res.json({ success: true, job: TranslationJobs.getJobSummary(job.id) });
  } catch (err) {
    console.error("❌ [translate-job-stop] Failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Resume job
app.post("/translate-job-resume/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const newJob = TranslationJobs.resumeJob(jobId);

    if (!newJob) {
      return res.status(404).json({ error: "Job not found or nothing to resume" });
    }

    // Start processing new job
    processJob(newJob.id);

    res.json({ success: true, job: TranslationJobs.getJobSummary(newJob.id) });
  } catch (err) {
    console.error("❌ Failed to resume job:", err);
    res.status(500).json({ error: err.message });
  }
});

// Retry failed files in job
app.post("/translate-job-retry/:jobId", authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔄 [translate-job-retry] Retrying job ${jobId}`);
    const job = TranslationJobs.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Reset failed files to pending
    job.files.forEach(f => {
      if (f.status === 'failed') {
        f.status = 'pending';
        f.error = null;
      }
    });

    job.status = 'pending';
    job.error = null;
    TranslationJobs.updateJob(jobId, job);

    // Start processing
    processJob(jobId);

    res.json({ success: true, job: TranslationJobs.getJobSummary(jobId) });
  } catch (err) {
    console.error("❌ Failed to retry job:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update batch size (threads) for a job - real-time control
app.post("/translate-job-batch-size/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const { batchSize } = req.body;

    if (!batchSize || isNaN(batchSize)) {
      return res.status(400).json({ error: "Invalid batchSize" });
    }

    const job = TranslationJobs.updateBatchSize(jobId, parseInt(batchSize));

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({ 
      success: true, 
      batchSize: job.batchSize,
      totalBatches: job.totalBatches,
    });
  } catch (err) {
    console.error("❌ Failed to update batch size:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get translated content from job
app.get("/translate-job-file/:jobId/:fileIndex", authMiddleware, (req, res) => {
  try {
    const { jobId, fileIndex } = req.params;
    const job = TranslationJobs.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const idx = parseInt(fileIndex);
    if (isNaN(idx) || idx < 0 || idx >= job.files.length) {
      return res.status(404).json({ error: "File not found in job" });
    }

    const file = job.files[idx];
    res.json({
      success: true,
      path: file.path,
      lang: file.lang,
      status: file.status,
      translated: file.translated || null,
      error: file.error || null,
    });
  } catch (err) {
    console.error("❌ Failed to get job file:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get all completed translations from job
app.get("/translate-job-results/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    const job = TranslationJobs.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const completedFiles = job.files
      .filter(f => f.status === 'completed' || f.status === 'skipped')
      .map(f => ({
        path: f.path,
        lang: f.lang,
        translated: f.translated,
      }));

    res.json({
      success: true,
      jobId,
      totalCompleted: completedFiles.length,
      files: completedFiles,
    });
  } catch (err) {
    console.error("❌ Failed to get job results:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get files ready for download (translated but not downloaded)
app.get("/translate-job-pending-download/:jobId", authMiddleware, (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔍 [Container] /translate-job-pending-download called - jobId: ${jobId}`);
    
    const files = TranslationJobs.getFilesReadyForDownload(jobId);
    const stats = TranslationJobs.getDownloadStats(jobId);

    console.log(`📋 [Container] Pending downloads - jobId: ${jobId}, files: ${files.length}, downloaded: ${stats?.downloaded || 0}`);

    res.json({
      success: true,
      jobId,
      stats,
      files,
    });
  } catch (err) {
    console.error("❌ [Container] Failed to get pending downloads:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get single file content for download
app.get("/translate-job-download/:jobId/:fileIndex", authMiddleware, (req, res) => {
  try {
    const { jobId, fileIndex } = req.params;
    console.log(`🔽 [Container] /translate-job-download called - jobId: ${jobId}, fileIndex: ${fileIndex}`);
    
    const job = TranslationJobs.getJob(jobId);

    if (!job) {
      console.error(`❌ [Container] Job not found: ${jobId}`);
      return res.status(404).json({ error: "Job not found" });
    }

    const file = job.files[parseInt(fileIndex)];
    if (!file) {
      console.error(`❌ [Container] File not found at index ${fileIndex}`);
      return res.status(404).json({ error: "File not found" });
    }

    if (!file.translated) {
      console.error(`❌ [Container] File not yet translated: ${file.path}`);
      return res.status(400).json({ error: "File not yet translated" });
    }

    console.log(`✅ [Container] Sending file content - ${file.path} (${file.content?.length || 0} chars)`);

    res.json({
      success: true,
      path: file.path,
      lang: file.lang,
      content: file.translated,
    });
  } catch (err) {
    console.error("❌ Failed to get file for download:", err);
    res.status(500).json({ error: err.message });
  }
});

// Mark file as downloaded
app.post("/translate-job-mark-downloaded/:jobId/:fileIndex", authMiddleware, (req, res) => {
  try {
    const { jobId, fileIndex } = req.params;
    console.log(`✔️  [Container] /translate-job-mark-downloaded called - jobId: ${jobId}, fileIndex: ${fileIndex}`);
    
    const job = TranslationJobs.markFileDownloaded(jobId, parseInt(fileIndex));

    if (!job) {
      console.error(`❌ [Container] Job or file not found`);
      return res.status(404).json({ error: "Job or file not found" });
    }

    const stats = TranslationJobs.getDownloadStats(jobId);
    console.log(`✅ [Container] Marked as downloaded - total downloaded: ${stats.downloaded}`);

    res.json({
      success: true,
      jobId,
      fileIndex: parseInt(fileIndex),
      stats,
    });
  } catch (err) {
    console.error("❌ [Container] Failed to mark file as downloaded:", err);
    res.status(500).json({ error: err.message });
  }
});

// Background job processor
async function processJob(jobId) {
  // Prevent duplicate processing
  if (activeProcessing.has(jobId)) {
    console.log(`⚠️ Job ${jobId} already being processed`);
    return;
  }

  activeProcessing.add(jobId);

  try {
    const job = TranslationJobs.getJob(jobId);
    if (!job) {
      console.error(`❌ Job ${jobId} not found`);
      return;
    }

    // Update job status
    TranslationJobs.updateJob(jobId, { 
      status: 'processing',
      startedAt: job.startedAt || Date.now(),
    });

    console.log(`🚀 Starting job ${jobId} for ${job.domain}`);
    
    let batchNum = 0;
    let noWorkIterations = 0;
    const MAX_NO_WORK_ITERATIONS = 30; // 30 iterations * 2 sec = 60 sec timeout
    
    // Process loop - runs until all files are done or job is stopped
    while (true) {
      // Check if job was stopped
      const currentJob = TranslationJobs.getJob(jobId);
      if (!currentJob || currentJob.status === 'stopped') {
        console.log(`🛑 Job ${jobId} was stopped`);
        break;
      }
      
      // Get pending files (have content, ready to translate)
      const pendingFiles = currentJob.files.filter(f => f.status === 'pending');
      const queuedFiles = currentJob.files.filter(f => f.status === 'queued');
      const processingFiles = currentJob.files.filter(f => f.status === 'processing');
      
      // Check if we're done
      if (pendingFiles.length === 0 && queuedFiles.length === 0 && processingFiles.length === 0) {
        console.log(`✅ Job ${jobId}: All files processed`);
        break;
      }
      
      // If no pending files but still have queued, wait for content
      if (pendingFiles.length === 0) {
        noWorkIterations++;
        if (noWorkIterations >= MAX_NO_WORK_ITERATIONS) {
          console.log(`⏰ Job ${jobId}: Timeout waiting for content`);
          break;
        }
        console.log(`⏳ Job ${jobId}: Waiting for content... (queued: ${queuedFiles.length}, iteration: ${noWorkIterations})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      noWorkIterations = 0; // Reset counter when we have work
      
      // Get batch size from job (can be changed in real-time)
      const batchSize = TranslationJobs.getBatchSize(jobId);
      const batch = pendingFiles.slice(0, batchSize);
      batchNum++;

      console.log(`📦 Job ${jobId}: Processing batch ${batchNum} (${batch.length} files, threads: ${batchSize})`);

      TranslationJobs.updateJob(jobId, { 
        currentBatch: batchNum,
        totalBatches: Math.ceil((pendingFiles.length + queuedFiles.length) / batchSize) + batchNum - 1,
      });

      // Mark files as processing
      batch.forEach(f => {
        TranslationJobs.updateFileStatus(jobId, f.path, f.lang, 'processing');
      });

      // Process batch in parallel
      await Promise.allSettled(
        batch.map(async (file) => {
          try {
            // 🔴 Повністю ігноруємо файли які не потребують перекладу
            // Вони тепер зберігаються в shared/ і не копіюються в папки перекладів
            const shouldSkip = file.path.endsWith('languages.blade.php') || 
                               file.path.includes('/css/') ||
                               file.path.endsWith('.css');

            if (shouldSkip) {
              console.log(`⏭️ Skipping shared file: ${file.path}`);
              TranslationJobs.updateFileStatus(jobId, file.path, file.lang, 'skipped', {
                translated: null, // НЕ копіюємо - файл в shared/
              });
              return;
            }

            // Translate with AI
            const completion = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: TRANSLATION_SYSTEM_MESSAGE(file.lang) },
                { role: "user", content: file.content },
              ],
              max_completion_tokens: 16000,
              temperature: 0.3,
            });

            const translated = BatchTranslation.sanitizeTranslatedTemplate(
              completion?.choices?.[0]?.message?.content || ""
            );

            if (!translated) {
              throw new Error("Empty translation result");
            }

            const tokens = completion?.usage?.total_tokens || 0;
            console.log(`✅ Translated: ${file.path} → ${file.lang} (${tokens} tokens, ${translated.length} chars)`);
            TranslationJobs.updateFileStatus(jobId, file.path, file.lang, 'completed', {
              translated,
            });

          } catch (err) {
            console.error(`❌ Translation failed for ${file.path} → ${file.lang}:`, err.message);
            TranslationJobs.updateFileStatus(jobId, file.path, file.lang, 'failed', {
              error: err.message,
            });
          }
        })
      );

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Final update
    const finalJob = TranslationJobs.getJob(jobId);
    if (finalJob && finalJob.status === 'processing') {
      const hasFailures = finalJob.files.some(f => f.status === 'failed');
      TranslationJobs.updateJob(jobId, {
        status: hasFailures ? 'completed_with_errors' : 'completed',
        completedAt: Date.now(),
      });
    }

    console.log(`✅ Job ${jobId} finished`);

  } catch (err) {
    console.error(`❌ Job ${jobId} failed:`, err);
    TranslationJobs.updateJob(jobId, {
      status: 'failed',
      error: err.message,
    });
  } finally {
    activeProcessing.delete(jobId);
  }
}


// --- Laravel Blade Translator BATCH (GPT-4o-mini for translations) - Legacy ---
app.post("/translate-blade-batch", authMiddleware, async (req, res) => {
  try {
    console.log("🌍 Batch translation request received.");

    const { files } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        error: "Array 'files' is required with objects {content, lang, path}.",
      });
    }

    const systemMessage = (lang) => TRANSLATION_SYSTEM_MESSAGE(lang);

    // Process all files in parallel with Promise.allSettled
    const results = await Promise.allSettled(
      files.map(async (file, index) => {
        const { content, lang, path } = file;

        if (!content || !lang || !path) {
          throw new Error(`File ${index}: missing content, lang, or path`);
        }

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini", // Fast and cheap for translations
          messages: [
            { role: "system", content: systemMessage(lang) },
            { role: "user", content },
          ],
          max_completion_tokens: 16000,
          temperature: 0.3, // Lower temperature for more consistent translations
        });

        const translated = BatchTranslation.sanitizeTranslatedTemplate(
          completion?.choices?.[0]?.message?.content || ""
        );

        if (!translated) {
          throw new Error(`No translated content for ${path}`);
        }

        return {
          path,
          lang,
          translated,
          tokens_used: completion?.usage?.total_tokens || 0,
        };
      })
    );

    // Separate successful and failed results
    const successful = [];
    const failed = [];

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successful.push(result.value);
      } else {
        failed.push({
          path: files[index].path,
          lang: files[index].lang,
          error: result.reason?.message || "Unknown error",
        });
      }
    });

    const totalTokens = successful.reduce((sum, r) => sum + r.tokens_used, 0);

    console.log(`✅ Batch translation complete: ${successful.length} success, ${failed.length} failed, ${totalTokens} tokens`);

    res.json({
      success: true,
      model: "gpt-4o-mini",
      total: files.length,
      successful,
      failed,
      tokens_used: totalTokens,
    });
  } catch (err) {
    console.error("❌ Batch translation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// --- Laravel Blade Translator (GPT-4o-mini for single file - legacy support) ---
app.post("/translate-blade", authMiddleware, async (req, res) => {
  try {
    console.log("🌍 Translation request received.");

    const { content, lang } = req.body;

    if (!content || !lang) {
      return res.status(400).json({
        error: "Both 'content' (Blade template) and 'lang' (language code) are required.",
      });
    }

// const systemMessage = `
// You are a professional website translator specializing in Laravel Blade templates.
// The website content is about **car rental services** (renting cars, booking, fleet, insurance, deals, locations, etc.).
// Translate ONLY visible human-readable text into ${lang}, keeping the car rental context natural and professional.

// Preserve all Blade directives (like @if, @foreach, @extends, @section, @yield),
// variables ({{ }}, {!! !!}), HTML tags, structure, and indentation.
// Do NOT translate or remove comments, Blade syntax, or HTML entities.

// Return ONLY the translated Blade template — no explanations, no markdown, just the code.
// Do NOT translate or modify $languageNames array.
// `;

const systemMessage = `
You are a professional website translator and content editor specializing in Laravel Blade templates.
The website content is related to car rental services (booking, pricing, fleet, airport rentals, insurance, deals, locations, etc.).

Your task is to translate all visible, human-readable text into ${lang}, but you are NOT limited to literal translation:
- You may paraphrase, restructure sentences, or rewrite the meaning when necessary.
- If a direct translation sounds unnatural, awkward, too literal, or unclear — rewrite it so it reads naturally for a native speaker.
- Improve clarity, flow, tone, and readability, while maintaining the original intention.

STRICT PRESERVATION RULES (DO NOT MODIFY ANY OF THESE):
- DO NOT change, rewrite, translate, or alter ANY URLs, links, image sources, asset paths, filenames, folders, or file extensions (jpg/png/webp/css/js/svg).
- DO NOT change strings inside /assets/..., /images/..., /css/..., /js/..., or any other static resource paths.
- DO NOT modify JavaScript, CSS, Blade directives (@if, @foreach, @extends, etc.), variables ({{ }}, {!! !!}), comments, inline styles, classes, indentation, or HTML structure.
- DO NOT touch technical strings, slugs, SEO keywords inside URLs, or dynamic parameters.

TRANSLATE ONLY:
- Human-visible text content inside HTML tags.
- Ignore alt attributes of images if they contain slugs or filenames.

OUTPUT RULES:
- Output ONLY the translated Blade template (no explanations, notes, markdown, or commentary).
- Structure and formatting must remain 100% identical to the input.
`;


    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast and cheap for translations
      
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content },
      ],
      max_completion_tokens: 16000,
      temperature: 0.3, // Lower temperature for more consistent translations
    });

const translated = BatchTranslation.sanitizeTranslatedTemplate(
  completion?.choices?.[0]?.message?.content || ""
);

    if (!translated) {
      throw new Error("No translated content received from GPT-4o-mini.");
    }

    console.log("✅ Translation complete for language:", lang);

    res.json({
      success: true,
      model: "gpt-4o-mini",
      lang,
      translated,
      tokens_used: completion?.usage?.total_tokens,
    });
  } catch (err) {
    console.error("❌ Blade translation failed:", err);
    res.status(500).json({ error: err.message });
  }
});



// --- Deep Article Route (Reasoning Model) ---
app.post("/article", authMiddleware, async (req, res) => {
  try {
    console.log("🧠 Deep article generation request received.");
    const { prompt, provider = "openai", model = "" } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const normalizedProvider = String(provider || "openai").toLowerCase();
    const providerUsed = (normalizedProvider === "anthropic" || normalizedProvider === "claude") ? "anthropic" : "openai";

    const systemMessage =
      "You are a professional SEO writer who creates long, well-structured HTML articles with clear headings, subheadings, lists, tables, and FAQ sections when needed. " +
      "Focus on factual, detailed, and logically organized content. Return ONLY raw HTML (no markdown, code fences, or explanations).";

    const userMessage = `${prompt}\n\nIMPORTANT: Return ONLY the full HTML of a comprehensive article.`;

    if (providerUsed === "anthropic") {
      const content = await generateTextWithAnthropic({
        systemMessage,
        userMessage,
        maxTokens: 12000,
        temperature: 0.4,
      });

      const modelUsed = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
      console.log(`🧠 /article using provider=anthropic model=${modelUsed}`);
      console.log("✅ Deep article generated (anthropic). Length:", String(content || "").length);

      return res.json({
        provider_used: "anthropic",
        model_used: modelUsed,
        html: content,
      });
    }

    let content = "";
    const openAiModel = resolveOpenAIModel(model, process.env.OPENAI_MODEL_QUALITY || "gpt-4o-mini");
    let modelUsed = openAiModel;
    let tokensUsed;
    let finalProviderUsed = "openai";

    try {
      const completion = await openai.chat.completions.create({
        model: openAiModel,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        max_completion_tokens: 50000,
        reasoning_effort: openAiModel === "gpt-5-nano" ? "low" : "medium",
        verbosity: "medium"
      });

      content =
        completion?.choices?.[0]?.message?.content ??
        completion?.choices?.[0]?.delta?.content ??
        completion?.choices?.[0]?.text ??
        "";
      tokensUsed = completion?.usage?.total_tokens;

      console.log(`🧠 /article using provider=openai model=${openAiModel}`);
      console.log("✅ Deep article generated (openai). Length:", String(content || "").length);
    } catch (err) {
      if (isOpenAIQuotaOrRateLimitError(err) && canFallbackToAnthropic()) {
        console.warn("⚠️ OpenAI quota/rate limit on /article. Falling back to Anthropic.");
        content = await generateTextWithAnthropic({
          systemMessage,
          userMessage,
          maxTokens: 12000,
          temperature: 0.4,
        });
        finalProviderUsed = "anthropic";
        modelUsed = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
        console.log(`🧠 /article fallback provider=anthropic model=${modelUsed}`);
        console.log("✅ Deep article generated (anthropic fallback). Length:", String(content || "").length);
      } else {
        throw err;
      }
    }

    res.json({
      provider_used: finalProviderUsed,
      model_used: modelUsed,
      model: modelUsed,
      tokens_used: tokensUsed,
      html: content,
    });
  } catch (err) {
    console.error("❌ Deep article generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/style", authMiddleware, async (req, res) => {
  try {
    console.log("🎨 Style generation request received.");
    const { prompt, provider = "openai", model = "" } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const normalizedProvider = String(provider || "openai").toLowerCase();
    const providerUsed = (normalizedProvider === "anthropic" || normalizedProvider === "claude") ? "anthropic" : "openai";

    const systemMessage =
      "You are a professional web designer who generates pure CSS code for websites. " +
      "Your task is to output ONLY valid CSS, with no HTML tags, no Markdown, no explanations, and no natural language. " +
      "Do not include <style> tags or code fences. Start directly with CSS selectors (e.g. header, main h1, etc.).";

    const userMessage =
      `${prompt}\n\nIMPORTANT: Return ONLY raw CSS — start directly with selectors, no comments or text before or after.`;

    let content = "";
    let modelUsed = "";
    let tokensUsed;
    let finalProviderUsed = providerUsed;
    const openAiModel = resolveOpenAIModel(model, process.env.OPENAI_MODEL_QUALITY || "gpt-4o-mini");

    if (providerUsed === "anthropic") {
      content = await generateTextWithAnthropic({
        systemMessage,
        userMessage,
        maxTokens: 8000,
        temperature: 0.3,
      });
      modelUsed = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
      console.log(`🧠 /style using provider=anthropic model=${modelUsed}`);
    } else {
      try {
        const completion = await openai.chat.completions.create({
          model: openAiModel,
          messages: [
            { role: "system", content: systemMessage },
            { role: "user", content: userMessage }
          ],
          max_completion_tokens: 20000,
          reasoning_effort: "medium"
        });

        const choice = completion?.choices?.[0];
        if (choice) {
          content =
            choice.message?.content?.trim() ||
            choice.delta?.content?.trim() ||
            choice.text?.trim() ||
            "";
        }

        modelUsed = openAiModel;
        tokensUsed = completion?.usage?.total_tokens;
        console.log(`🧠 /style using provider=openai model=${openAiModel}`);
      } catch (err) {
        if (isOpenAIQuotaOrRateLimitError(err) && canFallbackToAnthropic()) {
          console.warn("⚠️ OpenAI quota/rate limit on /style. Falling back to Anthropic.");
          content = await generateTextWithAnthropic({
            systemMessage,
            userMessage,
            maxTokens: 8000,
            temperature: 0.3,
          });
          modelUsed = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
          finalProviderUsed = "anthropic";
          console.log(`🧠 /style fallback provider=anthropic model=${modelUsed}`);
        } else {
          throw err;
        }
      }
    }

    if (!content) {
      console.warn("⚠️ No CSS content returned by model.");
      return res.status(500).json({ error: "No CSS generated." });
    }

    // 🔍 Лог короткого прев’ю CSS
    console.log("✅ CSS generated (preview):", content.slice(0, 300), "…");
    console.log("✅ CSS length:", content.length, "chars");

    res.json({
      success: true,
      provider_used: finalProviderUsed,
      model_used: modelUsed,
      model: modelUsed,
      tokens_used: tokensUsed,
      css: content
    });
  } catch (err) {
    console.error("❌ Style generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});



function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") {
    return next(); // never block OPTIONS
  }

  const header = req.headers["authorization"];
  if (!header) return res.status(403).json({ error: "Missing Authorization header" });

  const [type, token] = header.split(" ");
  if (type !== "Bearer" || token !== process.env.API_SECRET_TOKEN) {
    return res.status(403).json({ error: "Invalid token" });
  }

  next();
}


// ================== PROCESS UPLOADED LOGO (REMBG + TRIM) ==================
app.post("/process-uploaded-logo", authMiddleware, async (req, res) => {
  try {
    const { image_base64 } = req.body;
    
    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 is required" });
    }

    console.log(`🔧 [Upload] Processing uploaded logo with rembg + trim...`);

    const timestamp = Date.now();
    const buffer = Buffer.from(image_base64, "base64");

    // Save temporary file
    const tempInputPath = path.join(outputDir, `upload_temp_${timestamp}.png`);
    const tempOutputPath = path.join(outputDir, `upload_nobg_${timestamp}.png`);
    
    fs.writeFileSync(tempInputPath, buffer);

    // Remove background with Python rembg
    try {
      execSync(`python3 remove-bg.py "${tempInputPath}" "${tempOutputPath}"`, {
        cwd: process.cwd(),
        stdio: 'inherit'
      });
      console.log(`✅ [Upload] Background removed`);
    } catch (pythonErr) {
      console.error(`❌ Python rembg failed, using original`);
      fs.writeFileSync(tempOutputPath, buffer);
    }

    // Trim transparent edges
    const trimmed = await sharp(tempOutputPath).trim().toBuffer();
    
    // Convert to PNG and WebP
    const finalPng = await sharp(trimmed).png().toBuffer();
    const finalWebp = await sharp(trimmed).webp({ quality: 90 }).toBuffer();

    // Cleanup temp files
    if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);

    console.log(`✅ [Upload] Logo processed successfully`);

    res.json({
      success: true,
      png_base64: finalPng.toString("base64"),
      webp_base64: finalWebp.toString("base64"),
    });

  } catch (err) {
    console.error("❌ Uploaded logo processing failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// ================== BATCH API TRANSLATION ENDPOINTS ==================

// Start batch translation job
app.post("/translate-batch-start", authMiddleware, async (req, res) => {
  try {
    const { siteId, domain, files, model } = req.body;
    console.log(`📦 [batch-start] Request: siteId=${siteId}, domain=${domain}, files=${files?.length}, model=${model}`);

    if (!siteId || !domain || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Required: siteId, domain, files[] with content" });
    }

    // All files must have content for batch mode
    const missingContent = files.filter(f => !f.content);
    if (missingContent.length > 0) {
      return res.status(400).json({
        error: `${missingContent.length} files missing content. Batch mode requires all content upfront.`,
      });
    }

    // Check for existing active batch job
    const existing = TranslationJobs.getActiveJobForSite(siteId);
    if (existing && existing.mode === 'batch') {
      return res.json({
        success: true,
        job: TranslationJobs.getJobSummary(existing.id),
        message: 'Existing active batch job found',
      });
    }

    const batchModel = model || 'gpt-4o-mini';

    // Create job
    const job = TranslationJobs.createBatchJob(siteId, domain, files, batchModel);

    // Build JSONL
    const jsonl = BatchTranslation.createBatchJsonl(job.files, TRANSLATION_SYSTEM_MESSAGE, batchModel);
    if (!jsonl || jsonl.trim().length === 0) {
      return res.status(400).json({ error: 'No valid files to translate' });
    }

    console.log(`📦 Batch JSONL created: ${jsonl.split('\n').length} lines, ${jsonl.length} bytes`);

    // Mark job as uploading and respond immediately so the HTTP request
    // doesn't time out while we upload what can be a large JSONL to OpenAI.
    TranslationJobs.updateJob(job.id, {
      status: 'batch_uploading',
      startedAt: Date.now(),
    });

    res.json({
      success: true,
      job: TranslationJobs.getJobSummary(job.id),
      message: 'Batch upload started (background)',
    });

    // Upload & start batch in background
    setImmediate(async () => {
      try {
        const batchResult = await BatchTranslation.uploadAndStartBatch(jsonl);

        // Update job with batch info
        TranslationJobs.updateBatchStatus(job.id, {
          batchApiId: batchResult.batchId,
          inputFileId: batchResult.inputFileId,
          status: batchResult.status,
          requestCounts: batchResult.requestCounts,
        });
        TranslationJobs.updateJob(job.id, {
          status: 'batch_submitted',
          batchSubmittedAt: Date.now(),
        });

        // Mark all files as submitted
        job.files.forEach((f) => {
          if (f.status === 'batch_queued') {
            TranslationJobs.updateFileStatus(job.id, f.path, f.lang, 'batch_submitted');
          }
        });

        console.log(`✅ [batch-start] Background upload done: batchId=${batchResult.batchId}`);
      } catch (err) {
        console.error('❌ [batch-start] Background upload failed:', err);
        TranslationJobs.updateJob(job.id, { status: 'failed', error: err.message });
      }
    });
  } catch (err) {
    console.error('❌ Batch start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get batch job status
app.get("/translate-batch-status/:jobId", authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔍 [batch-status] Checking job ${jobId}`);
    const job = TranslationJobs.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    let batchStatus = null;
    if (job.batchApiId && !['failed', 'completed', 'cancelled'].includes(job.status)) {
      try {
        batchStatus = await BatchTranslation.pollBatchStatus(job.batchApiId);
        TranslationJobs.updateBatchStatus(jobId, {
          status: batchStatus.status,
          requestCounts: batchStatus.requestCounts,
          outputFileId: batchStatus.outputFileId,
          errorFileId: batchStatus.errorFileId,
        });
      } catch (e) {
        console.error('Failed to poll batch status:', e.message);
      }
    }

    res.json({
      success: true,
      job: TranslationJobs.getJobSummary(jobId),
      batchStatus,
    });
  } catch (err) {
    console.error('❌ Batch status failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Download and apply batch results
app.post("/translate-batch-results/:jobId", authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`📥 [batch-results] Downloading results for job ${jobId}`);
    const job = TranslationJobs.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // If job already failed, return cached state without re-processing
    if (job.status === 'failed') {
      return res.json({
        success: false,
        allFailed: true,
        error: job.error || 'Batch failed',
        job: TranslationJobs.getJobSummary(jobId),
      });
    }

    if (!job.outputFileId && job.batchApiId) {
      // Fetch latest status
      const status = await BatchTranslation.pollBatchStatus(job.batchApiId);
      if (status.outputFileId) {
        TranslationJobs.updateBatchStatus(jobId, {
          status: status.status,
          outputFileId: status.outputFileId,
          errorFileId: status.errorFileId,
        });
        job.outputFileId = status.outputFileId;
      }
    }

    if (!job.outputFileId) {
      // Check if batch completed but all requests failed (no output, only error file)
      if (job.batchApiStatus === 'completed' || (job.batchApiId && (await BatchTranslation.pollBatchStatus(job.batchApiId)).status === 'completed')) {
        let errorMessage = 'All batch requests failed';
        if (job.errorFileId) {
          const errors = await BatchTranslation.downloadBatchErrors(job.errorFileId);
          if (errors.length > 0) {
            const firstErr = errors[0];
            errorMessage = firstErr?.response?.body?.error?.message || firstErr?.error?.message || errorMessage;
            console.log(`❌ [batch-results] All ${errors.length} requests failed. First error: ${errorMessage}`);
          }
        }
        // Mark all files as failed
        job.files.forEach(f => {
          if (['batch_submitted', 'batch_queued', 'pending'].includes(f.status)) {
            f.status = 'failed';
            f.error = errorMessage;
          }
        });
        TranslationJobs.updateJob(jobId, { status: 'failed', error: errorMessage, completedAt: Date.now(), files: job.files });
        return res.json({
          success: false,
          allFailed: true,
          error: errorMessage,
          job: TranslationJobs.getJobSummary(jobId),
        });
      }
      return res.status(400).json({ error: 'Batch not yet completed — no output file available' });
    }

    // Download results
    const results = await BatchTranslation.downloadBatchResults(job.outputFileId);
    console.log(`📥 Downloaded ${results.length} batch results for job ${jobId}`);

    // Validate each result
    let validOk = 0, validFail = 0;
    const processedResults = results.map(r => {
      const file = job.files[r.fileIndex];
      if (!r.translated || r.error) {
        return { ...r, validationErrors: null };
      }
      if (file && file.content) {
        const meta = `(${file.path}→${file.lang})`;
        const validation = BatchTranslation.validateTranslation(file.content, r.translated, meta);
        if (validation.valid) validOk++; else validFail++;
        return {
          ...r,
          validationErrors: validation.valid ? null : validation.errors,
        };
      }
      return { ...r, validationErrors: null };
    });
    console.log(`✅ [batch-results] Validation: ${validOk} passed, ${validFail} failed`);

    // Apply to job
    const stats = TranslationJobs.applyBatchResults(jobId, processedResults);

    // Download errors if any
    if (job.errorFileId) {
      const errors = await BatchTranslation.downloadBatchErrors(job.errorFileId);
      if (errors.length > 0) {
        console.log(`⚠️ Batch ${jobId} had ${errors.length} error entries`);
      }
    }

    res.json({
      success: true,
      job: TranslationJobs.getJobSummary(jobId),
      stats,
    });
  } catch (err) {
    console.error('❌ Batch results download failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Retry failed/validation-failed files as new batch
app.post("/translate-batch-retry/:jobId", authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = TranslationJobs.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if ((job.retriesLeft ?? 0) <= 0) {
      return res.status(400).json({ error: 'No retries left. Review failed files manually.' });
    }

    const retryFiles = TranslationJobs.getRetryFiles(jobId);
    if (retryFiles.length === 0) {
      return res.json({ success: true, message: 'No files need retry' });
    }

    // Reset files for retry
    const resetCount = TranslationJobs.resetFilesForRetry(jobId);

    // Build JSONL with only the retry files
    const filesToRetry = job.files.filter(f => f.status === 'batch_queued');
    const jsonl = BatchTranslation.createBatchJsonl(
      filesToRetry.map((f, i) => ({ ...f, _origIndex: job.files.indexOf(f) })),
      TRANSLATION_SYSTEM_MESSAGE,
      job.batchModel || 'gpt-4o-mini'
    );

    // We need a new JSONL that maps back to original indices
    // Rebuild with correct indices
    const retryJsonlLines = [];
    for (let i = 0; i < job.files.length; i++) {
      const f = job.files[i];
      if (f.status !== 'batch_queued') continue;
      retryJsonlLines.push(JSON.stringify({
        custom_id: `idx::${i}`,
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: job.batchModel || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: TRANSLATION_SYSTEM_MESSAGE(f.lang) },
            { role: 'user', content: f.content },
          ],
          max_completion_tokens: 16000,
          temperature: 0.3,
        },
      }));
    }
    const retryJsonl = retryJsonlLines.join('\n');

    // Upload & start new batch
    const batchResult = await BatchTranslation.uploadAndStartBatch(retryJsonl);

    TranslationJobs.updateBatchStatus(jobId, {
      batchApiId: batchResult.batchId,
      inputFileId: batchResult.inputFileId,
      status: batchResult.status,
      requestCounts: batchResult.requestCounts,
    });
    TranslationJobs.updateJob(jobId, {
      status: 'batch_submitted',
      batchSubmittedAt: Date.now(),
    });

    // Mark retry files as submitted
    job.files.forEach(f => {
      if (f.status === 'batch_queued') {
        f.status = 'batch_submitted';
      }
    });
    TranslationJobs.updateJob(jobId, { files: job.files });

    res.json({
      success: true,
      retried: resetCount,
      retriesLeft: job.retriesLeft,
      batchId: batchResult.batchId,
      job: TranslationJobs.getJobSummary(jobId),
    });
  } catch (err) {
    console.error('❌ Batch retry failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cancel a batch job
app.post("/translate-batch-cancel/:jobId", authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🛑 [batch-cancel] Cancelling job ${jobId}`);
    const job = TranslationJobs.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.batchApiId) {
      try {
        await BatchTranslation.cancelBatch(job.batchApiId);
      } catch (e) {
        console.log('Batch cancel API error (may already be done):', e.message);
      }
    }

    TranslationJobs.updateJob(jobId, { status: 'stopped' });
    TranslationJobs.updateBatchStatus(jobId, { status: 'cancelled' });

    res.json({
      success: true,
      job: TranslationJobs.getJobSummary(jobId),
    });
  } catch (err) {
    console.error('❌ Batch cancel failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get batch file content for download (reuse same pattern as realtime)
app.get("/translate-batch-download/:jobId/:fileIndex", authMiddleware, (req, res) => {
  try {
    const { jobId, fileIndex } = req.params;
    const job = TranslationJobs.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const file = job.files[parseInt(fileIndex)];
    if (!file) { console.warn(`⚠️ [batch-download] File index ${fileIndex} not found in job ${jobId}`); return res.status(404).json({ error: 'File not found' }); }
    if (!file.translated) { console.warn(`⚠️ [batch-download] File ${file.path}→${file.lang} not yet translated`); return res.status(400).json({ error: 'File not yet translated' }); }
    console.log(`📥 [batch-download] Serving ${file.path}→${file.lang} (${file.translated.length} chars)`);

    res.json({
      success: true,
      content: file.translated,
      path: file.path,
      lang: file.lang,
      status: file.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Background Batch Poller ────────────────────────────────────

async function pollActiveBatches() {
  const activeJobs = TranslationJobs.getActiveBatchJobs();
  if (activeJobs.length === 0) return;

  for (const job of activeJobs) {
    if (!job.batchApiId) continue;

    try {
      const status = await BatchTranslation.pollBatchStatus(job.batchApiId);

      TranslationJobs.updateBatchStatus(job.id, {
        status: status.status,
        requestCounts: status.requestCounts,
        outputFileId: status.outputFileId,
        errorFileId: status.errorFileId,
      });

      console.log(`🔄 Batch poll ${job.id}: ${status.status} (${status.requestCounts?.completed || 0}/${status.requestCounts?.total || '?'})`);

      // Handle completed batch with ALL requests failed (no output file)
      if (status.status === 'completed' && !status.outputFileId) {
        let errorMessage = 'All batch requests failed';
        if (status.errorFileId) {
          try {
            const errors = await BatchTranslation.downloadBatchErrors(status.errorFileId);
            if (errors.length > 0) {
              errorMessage = errors[0]?.response?.body?.error?.message || errors[0]?.error?.message || errorMessage;
            }
          } catch(e) { console.error('Failed to download error file:', e.message); }
        }
        console.log(`❌ Batch ${job.id} completed with ALL failures: ${errorMessage}`);
        TranslationJobs.updateJob(job.id, {
          status: 'failed',
          error: errorMessage,
          completedAt: Date.now(),
        });
        job.files.forEach(f => {
          if (['batch_submitted', 'batch_queued'].includes(f.status)) {
            f.status = 'failed';
            f.error = errorMessage;
          }
        });
        TranslationJobs.updateJob(job.id, { files: job.files });
        continue;
      }

      // Auto-download results when batch completes
      if (status.status === 'completed' && status.outputFileId) {
        console.log(`📥 Auto-downloading batch results for job ${job.id}`);

        const results = await BatchTranslation.downloadBatchResults(status.outputFileId);

        // Validate each
        const processedResults = results.map(r => {
          const file = job.files[r.fileIndex];
          if (!r.translated || r.error) return { ...r, validationErrors: null };
          if (file?.content) {
            const meta = `(${file.path}→${file.lang})`;
            const v = BatchTranslation.validateTranslation(file.content, r.translated, meta);
            return { ...r, validationErrors: v.valid ? null : v.errors };
          }
          return { ...r, validationErrors: null };
        });

        const stats = TranslationJobs.applyBatchResults(job.id, processedResults);
        console.log(`✅ Batch ${job.id} results applied: ${stats.completed} ok, ${stats.failed} failed, ${stats.validationFailed} validation errors`);

        // Auto-retry if there are failed files and retries left
        if ((stats.failed > 0 || stats.validationFailed > 0) && (job.retriesLeft ?? 0) > 0) {
          console.log(`🔄 Auto-retrying ${stats.failed + stats.validationFailed} files for job ${job.id}`);
          const resetCount = TranslationJobs.resetFilesForRetry(job.id);
          if (resetCount > 0) {
            const updatedJob = TranslationJobs.getJob(job.id);
            const retryLines = [];
            for (let i = 0; i < updatedJob.files.length; i++) {
              const f = updatedJob.files[i];
              if (f.status !== 'batch_queued') continue;
              retryLines.push(JSON.stringify({
                custom_id: `idx::${i}`,
                method: 'POST',
                url: '/v1/chat/completions',
                body: {
                  model: updatedJob.batchModel || 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: TRANSLATION_SYSTEM_MESSAGE(f.lang) },
                    { role: 'user', content: f.content },
                  ],
                  max_completion_tokens: 16000,
                  temperature: 0.3,
                },
              }));
            }
            if (retryLines.length > 0) {
              const batchResult = await BatchTranslation.uploadAndStartBatch(retryLines.join('\n'));
              TranslationJobs.updateBatchStatus(updatedJob.id, {
                batchApiId: batchResult.batchId,
                inputFileId: batchResult.inputFileId,
                status: batchResult.status,
                requestCounts: batchResult.requestCounts,
              });
              TranslationJobs.updateJob(updatedJob.id, {
                status: 'batch_submitted',
                batchSubmittedAt: Date.now(),
              });
              updatedJob.files.forEach(f => {
                if (f.status === 'batch_queued') f.status = 'batch_submitted';
              });
              TranslationJobs.updateJob(updatedJob.id, { files: updatedJob.files });
              console.log(`🚀 Retry batch submitted: ${batchResult.batchId} (${retryLines.length} files)`);
            }
          }
        }
      }

      // Handle failed/expired batches
      if (['failed', 'expired', 'cancelled'].includes(status.status)) {
        TranslationJobs.updateJob(job.id, {
          status: 'failed',
          error: `Batch ${status.status}: ${status.errors?.data?.[0]?.message || 'unknown error'}`,
          completedAt: Date.now(),
        });
        // Mark submitted files as failed
        job.files.forEach(f => {
          if (f.status === 'batch_submitted') {
            f.status = 'failed';
            f.error = `Batch ${status.status}`;
          }
        });
        TranslationJobs.updateJob(job.id, { files: job.files });
      }
    } catch (err) {
      console.error(`❌ Batch poll error for job ${job.id}:`, err.message);
    }
  }
}

// Poll every 30 seconds
setInterval(pollActiveBatches, 30 * 1000);

app.listen(process.env.PORT, () =>
  console.log(`✅ OpenAI API running on port ${process.env.PORT}`)
);
