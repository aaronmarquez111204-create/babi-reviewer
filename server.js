const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let memoryApiKey = process.env.GEMINI_API_KEY || null;

// Helper to get active API key
const getApiKey = () => memoryApiKey;

// 1. Endpoint: Set API Key
app.post('/api/setApiKey', (req, res) => {
  const { key } = req.body;
  memoryApiKey = key;
  res.json("API Key saved securely in runtime memory!");
});

// 2. Endpoint: Has API Key Check
app.post('/api/getHasApiKey', (req, res) => {
  res.json(!!getApiKey());
});

// 3. Endpoint: List Available Models
app.post('/api/listAvailableModels', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.json([]);

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) return res.json([]);
    const data = await response.json();
    const available = data.models
      .filter(m => m.supportedGenerationMethods.includes("generateContent"))
      .map(m => ({
        name: m.name.replace("models/", ""),
        displayName: m.displayName
      }));
    res.json(available);
  } catch (err) {
    res.json([]);
  }
});

// 4. Endpoint: Diagnostic Test
app.post('/api/testAiConnection', async (req, res) => {
  const { selectedModel } = req.body;
  try {
    const result = await _callGemini("Are you working? Reply with 'SYSTEM ACTIVE'", selectedModel);
    res.json("Success: " + result);
  } catch (err) {
    res.json("Critical Error: " + err.message);
  }
});

// Internal Gemini Call logic with Retry
async function _callGemini(prompt, selectedModel) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API Key found. Please add one in Settings.");

  // Switch default to Flash for 1,500 RPM limit (Pro is only 2 RPM)
  const modelToUse = selectedModel || 'gemini-1.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;

  const payload = {
    "contents": [{ "parts": [{ "text": prompt }] }]
  };

  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const status = response.status;
      const data = await response.text();

      if (status === 200) {
        const json = JSON.parse(data);
        if (json.candidates && json.candidates[0].content && json.candidates[0].content.parts) {
          let answer = json.candidates[0].content.parts.map(p => p.text).join(' ');

          if (answer.startsWith("```json")) answer = answer.substring(7);
          if (answer.startsWith("```")) answer = answer.substring(3);
          if (answer.endsWith("```")) answer = answer.substring(0, answer.length - 3);

          return answer.trim();
        } else {
          throw new Error("No valid response from AI.");
        }
      } else if (status === 429) {
        if (attempts >= maxAttempts) throw new Error("429");
        // Faster retries for a better user experience (2s, 4s, 6s)
        const wait = attempts * 2000;
        console.log(`Rate limit hit. Retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
      } else if (status === 500 || status === 503) {
        if (attempts >= maxAttempts) throw new Error("503");
        await new Promise(r => setTimeout(r, 1500));
      } else {
        let errMsg = `Status ${status}`;
        try {
          const parsed = JSON.parse(data);
          errMsg = parsed.error ? parsed.error.message : data;
        } catch (e) { }
        throw new Error(errMsg);
      }
    } catch (e) {
      if (e.message === "429" || e.message === "503") throw e;
      if (attempts >= maxAttempts) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// 5. Endpoint: Generate Quiz
app.post('/api/generateQuiz', async (req, res) => {
  const { contextText, numQuestions, selectedModel } = req.body;
  let promptText = `Generate a ${numQuestions}-question multiple choice nursing quiz in JSON format from the following context...`; // Condensed prompt
  const prompt = `You are an elite nursing AI creating a challenging ${numQuestions}-question multiple choice quiz.\n\nThe context to generate the quiz from is below:\n\n---\n${contextText}\n---\n\nINSTRUCTIONS:\n1. Create EXACTLY ${numQuestions} DISTINCT questions. \n2. CRITICAL: DO NOT REPEAT THE SAME QUESTION OR TOPIC. Each question must cover a UNIQUE concept from the text.\n3. Output MUST be ONLY a valid raw JSON array of objects. No markdown, No text before or after.\n4. Each JSON object MUST follow this EXACT structure:\n   {"question": "The question text", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 0, "rationale": "Why option 0 is correct."}\n5. 'answer' MUST be the integer index (0-3) of the correct option.\n6. Keep 'rationale' concise and clear.\n7. STRICT REQUIREMENT: Ensure the JSON syntax is perfectly valid and properly closed.`;

  try {
    const rawText = await _callGemini(prompt, selectedModel);
    // Parse the AI text into a real JSON array before sending
    let questions;
    try {
      questions = JSON.parse(rawText);
    } catch (parseErr) {
      // Try to extract JSON array if there's extra text around it
      const match = rawText.match(/\[.*\]/s);
      if (match) {
        questions = JSON.parse(match[0]);
      } else {
        throw new Error('AI returned invalid JSON. Try again or use a different model.');
      }
    }
    res.json(questions); // Send the actual array
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Endpoint: Explain Content
app.post('/api/explainContent', async (req, res) => {
  const { contextText, selectedModel } = req.body;
  const prompt = `Simplify this text for a nursing student review.\n\nText:\n${contextText}\n\n1. Provide a 1-PARAGRAPH BRIEF OVERVIEW of the main concept.\n2. Provide 3-5 CRITICAL NURSING BULLET POINTS.\n3. Add the separator \"---FLASHCARD---\".\n4. Provide a SHORT QUESTION (max 12 words) for a flashcard front face.`;

  try {
    const text = await _callGemini(prompt, selectedModel);
    res.json({ explanation: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Endpoint: Define Word
app.post('/api/defineWord', async (req, res) => {
  const { word, contextText, selectedModel } = req.body;
  const prompt = `Medical Term: '${word}'. \n\n1. Definition: Provide a strictly ONE-SENTENCE definition (max 15 words).\n2. Add: \"---FLASHCARD---\".\n3. Question: Provide a SHORT QUESTION (max 10 words) where this term is the answer.\n\nFORBIDDEN: Do not include types, diagnosis, or treatments unless they fit within the 15-word limit.`;



  try {
    const text = await _callGemini(prompt, selectedModel);
    res.json({ definition: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Babi's Reviewer backend running locally on http://localhost:${PORT}`));
