const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
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

// 5. Endpoint: AI Tutor Chat
app.post('/api/chat', async (req, res) => {
  const { prompt, selectedModel } = req.body;
  try {
    const result = await _callGemini(prompt, selectedModel);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Internal Gemini Call logic with Retry
async function _callGemini(prompt, selectedModel, expectJson = false) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No API Key found. Please add one in Settings.");

  // Ensure model name has 'models/' prefix
  let modelName = selectedModel || 'gemini-2.5-flash';
  if (!modelName.startsWith('models/')) {
    modelName = `models/${modelName}`;
  }
    
  // Use v1beta to support advanced features like responseMimeType (JSON Mode)
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

  const payload = {
    "contents": [{ "parts": [{ "text": prompt }] }]
  };

  if (expectJson) {
    payload.generationConfig = { responseMimeType: "application/json" };
  }

  let attempts = 0;
  const maxAttempts = 15;

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
        // Longer retries to smoothly wait out the free tier limit (8s, 11s, 14s...)
        const wait = 5000 + (attempts * 3000);
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
  const { contextText, count, selectedModel } = req.body;
  const numQuestions = count || 10; // Default to 10 if not provided
  
  const batchSize = 20; // 20 questions max per request to avoid hitting the 8192 output token limit
  let allQuestions = [];
  
  try {
    let remaining = numQuestions;
    
    while (remaining > 0) {
      const currentBatch = Math.min(remaining, batchSize);
      
      let historyPrompt = "";
      if (allQuestions.length > 0) {
        const asked = allQuestions.map((q, i) => `${i+1}. ${q.question}`).join('\n');
        historyPrompt = `\nCRITICAL: You have already asked the following questions. DO NOT ask them again or test the exact same concepts:\n${asked}\n`;
      }
      
      const prompt = `You are an elite nursing AI creating a challenging ${currentBatch}-question multiple choice quiz.\n\nThe context to generate the quiz from is below:\n\n---\n${contextText}\n---\n${historyPrompt}\nINSTRUCTIONS:\n1. Create EXACTLY ${currentBatch} DISTINCT questions.\n2. Output MUST be ONLY a valid raw JSON array of objects. No markdown, No text before or after.\n3. Each JSON object MUST follow this EXACT structure:\n   {"question": "The question text", "options": ["Option A", "Option B", "Option C", "Option D"], "answer": 0, "rationale": "Why option 0 is correct."}\n4. 'answer' MUST be the integer index (0-3) of the correct option.\n5. Keep 'rationale' concise and clear.\n6. STRICT REQUIREMENT: Ensure the JSON syntax is perfectly valid and properly closed.`;
      
      const rawText = await _callGemini(prompt, selectedModel, true);
      
      let questions;
      try {
        questions = JSON.parse(rawText);
      } catch (parseErr) {
        const match = rawText.match(/\[.*\]/s);
        if (match) {
          questions = JSON.parse(match[0]);
        } else {
          throw new Error(`AI returned invalid JSON at batch ${allQuestions.length / batchSize + 1}. Try again.`);
        }
      }
      
      if (Array.isArray(questions)) {
        allQuestions = allQuestions.concat(questions);
      }
      
      remaining -= currentBatch;
      
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, 1000)); // Respect rate limits
      }
    }
    
    res.json(allQuestions.slice(0, numQuestions)); 
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

// 6.5 Endpoint: Generate Mnemonic
app.post('/api/generateMnemonic', async (req, res) => {
  const { contextText, selectedModel } = req.body;
  const prompt = `Act as an expert nursing tutor. Generate a highly catchy and memorable acronym or mnemonic for the following medical/nursing text. Format your response clearly using Markdown. Make sure it is directly applicable for rote memorization in an exam setting.\n\nText:\n${contextText}`;

  try {
    const text = await _callGemini(prompt, selectedModel);
    res.json({ mnemonic: text });
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
