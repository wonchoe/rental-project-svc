import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import cors from "cors";

dotenv.config();

const app = express();

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

app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 📁 Папка для збереження зображень
const outputDir = path.join(process.cwd(), "output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// Роздаємо статичні файли
app.use("/output", express.static(outputDir));

// 🎯 Мапа підтримуваних розмірів
const sizeMap = {
  1: "1024x1024",
  2: "1536x1024",
  3: "1024x1536",
  4: "auto"
};



app.post("/generate-favicon", cors(), async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log(`🎨 Generating favicon: "${prompt}"`);

    // 1️⃣ Генеруємо 1024×1024 з прозорим фоном
    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: `${prompt}, centered object, transparent background, no text`,
      n: 1,
      size: "1024x1024",
      background: "transparent",
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




app.post("/generate", cors(), async (req, res) => {
  try {
    const { prompt, n = 4, size = 1 } = req.body;
    const selectedSize = sizeMap[size] || sizeMap[1];

    console.log(`🧠 Generating "${prompt}" with size: ${selectedSize}`);

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n,
      quality: "low",
      size: selectedSize,
      background: "transparent"
    });

    const timestamp = Date.now();
    const images = [];

    for (let index = 0; index < result.data.length; index++) {
      const item = result.data[index];
      if (!item.b64_json) continue;

      const buffer = Buffer.from(item.b64_json, "base64");
      const filename = `image_${timestamp}_${index + 1}.png`;
      const filepath = path.join(outputDir, filename);
      const sharp = (await import("sharp")).default;

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

      const baseUrl = `https://${req.get("host")}/output`;

      images.push({
        index: index + 1,
        png_url: `${baseUrl}/${filename}`,
        webp_url: `${baseUrl}/${webpName}`
      });
    }

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

app.post("/text", cors(), async (req, res) => {
  try {
    console.log("🧠 Text generation request received.");
    const { prompt, format = "", max_tokens = 10096, temperature = 0.9 } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    // Cap tokens to a reasonable upper bound to avoid accidental huge requests
    const maxTokens = Math.min(parseInt(max_tokens, 10) || 10096, 16000);

    // System-level instruction that enforces concise direct answers and HTML-only responses when requested
    const systemMessage =
      "You are an assistant that always replies in a clear, direct and concise way without explanations or extra commentary. " +
      "If the user requests HTML, return ONLY the raw HTML (no surrounding text, no code fences, no comments). " +
      "Always follow the user's requested format exactly.";

    // Reinforce the constraints in the user message as well
    const wantsHtml = (String(format).toLowerCase() === "html");
    const userMessage =
      prompt +
      "\n\nIMPORTANT: reply clearly and directly with no explanations. " +
      (wantsHtml ? "Return ONLY the HTML and nothing else." : "");

    const completion = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      max_completion_tokens: maxTokens,
      top_p: 1,
    });

    // Extract text from response (supports different response shapes)
    const content =
      completion?.choices?.[0]?.message?.content ??
      completion?.choices?.[0]?.text ??
      "";

    res.json({ text: content });
  } catch (err) {
    console.error("❌ Text generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


// --- Laravel Blade Translator (GPT-5 mini) ---
app.post("/translate-blade", cors(), async (req, res) => {
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
- You may improve clarity, flow, tone, and readability, while keeping the original intention and car-rental context.

STRICT PRESERVATION RULES:
- Keep all Blade directives (@if, @foreach, @extends, @section, @yield, etc.).
- Keep all variables ({{ }}, {!! !!}), HTML tags, attributes, classes, and indentation.
- Do NOT modify JavaScript code, CSS, Blade logic, comments, arrays, or special placeholders (including $languageNames).
- Do NOT translate or alter technical strings, URLs, routes, or template structure.

Your output must:
- Contain ONLY the translated Blade template (no explanations, no markdown, no comments).
- Maintain the original structure exactly.
- Rewrite only human-visible text content, ensuring a natural, professional tone for car-rental websites.
`;


    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini", // reasoning model
      
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content },
      ],
      max_completion_tokens: 50000,
      reasoning_effort: "medium", // make the model "think deeper"
      verbosity: "medium"         // produce longer and more detailed output
    });

const translated =
  (completion?.choices?.[0]?.message?.content?.trim() || "").replace(/—/g, "-");

    if (!translated) {
      throw new Error("No translated content received from GPT-5 mini.");
    }

    console.log("✅ Translation complete for language:", lang);

    res.json({
      success: true,
      model: "gpt-5-mini",
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
app.post("/article", cors(), async (req, res) => {
  try {
    console.log("🧠 Deep article generation request received.");
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const systemMessage =
      "You are a professional SEO writer who creates long, well-structured HTML articles with clear headings, subheadings, lists, tables, and FAQ sections when needed. " +
      "Focus on factual, detailed, and logically organized content. Return ONLY raw HTML (no markdown, code fences, or explanations).";

    const userMessage = `${prompt}\n\nIMPORTANT: Return ONLY the full HTML of a comprehensive article.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5", // reasoning model
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      max_completion_tokens: 50000,
      reasoning_effort: "high", // make the model "think deeper"
      verbosity: "high"         // produce longer and more detailed output
    });

    console.log("✅ Deep article generated.", completion);
    const content =
      completion?.choices?.[0]?.message?.content ??
      completion?.choices?.[0]?.delta?.content ??
      completion?.choices?.[0]?.text ??
      "";

      console.log("✅ Deep article generated.", content);

    res.json({
      model: "gpt-5",
      tokens_used: completion?.usage?.total_tokens,
      html: content,
    });
  } catch (err) {
    console.error("❌ Deep article generation failed:", err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/style", cors(), async (req, res) => {
  try {
    console.log("🎨 Style generation request received.");
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    const systemMessage =
      "You are a professional web designer who generates pure CSS code for websites. " +
      "Your task is to output ONLY valid CSS, with no HTML tags, no Markdown, no explanations, and no natural language. " +
      "Do not include <style> tags or code fences. Start directly with CSS selectors (e.g. header, main h1, etc.).";

    const userMessage =
      `${prompt}\n\nIMPORTANT: Return ONLY raw CSS — start directly with selectors, no comments or text before or after.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      max_completion_tokens: 20000,
      reasoning_effort: "medium"
    });

    // 🧩 Отримуємо сам CSS
    let content = "";
    const choice = completion?.choices?.[0];
    if (choice) {
      content =
        choice.message?.content?.trim() ||
        choice.delta?.content?.trim() ||
        choice.text?.trim() ||
        "";
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
      model: completion.model,
      tokens_used: completion?.usage?.total_tokens,
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

app.use(authMiddleware);


app.listen(process.env.PORT, () =>
  console.log(`✅ OpenAI API running on port ${process.env.PORT}`)
);
