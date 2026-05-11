/**
 * Main entry point for the Web App.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle("Babi's Reviewer")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Helper to include CSS/JS files into the main HTML.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * AI & API Key Management
 */
function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return "API Key saved successfully!";
}

function getHasApiKey() {
  return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

/**
 * NEW: List all models available to the current API Key
 */
function listAvailableModels() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return [];
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  try {
    const response = UrlFetchApp.fetch(url, { "muteHttpExceptions": true });
    const code = response.getResponseCode();
    if (code !== 200) return [];
    
    const data = JSON.parse(response.getContentText());
    // Filter for models that support generating content
    return data.models
      .filter(m => m.supportedGenerationMethods.includes("generateContent"))
      .map(m => ({
        name: m.name.replace("models/", ""), // Clean name for UI
        displayName: m.displayName
      }));
  } catch (e) {
    console.error("List Models Error: " + e.toString());
    return [];
  }
}

/**
 * Diagnostic Test: Check if AI can respond to basic text
 */
function testAiConnection(selectedModel) {
  try {
    const response = callGemini("Are you working? Reply with 'SYSTEM ACTIVE'", selectedModel);
    return "Success: " + response;
  } catch (e) {
    return "Critical Error: " + e.toString();
  }
}

/**
 * Unified helper to call Gemini with automatic retry logic (Exponential Backoff)
 */
function callGemini(prompt, selectedModel) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error("No API Key found. Please add one in Settings.");

  const modelToUse = selectedModel || 'gemini-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
  
  const payload = {
    "contents": [{ "parts": [{ "text": prompt }] }]
  };

  let lastError = null;
  let attempts = 0;
  const maxAttempts = 5; // Increased resilience

  while (attempts < maxAttempts) {
    try {
      attempts++;
      const response = UrlFetchApp.fetch(url, {
        "method": "post",
        "contentType": "application/json",
        "payload": JSON.stringify(payload),
        "muteHttpExceptions": true
      });

      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code === 200) {
        const result = JSON.parse(text);
        if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts) {
          return result.candidates[0].content.parts[0].text;
        }
        throw new Error("Invalid response format from Gemini.");
      }

      // Handle specific retryable errors (Busy/Overloaded/Quota)
      if (code === 503 || code === 429 || code === 500) {
        console.warn(`Gemini Busy/Quota (${code}). Attempt ${attempts} of ${maxAttempts}. Retrying...`);
        lastError = code === 429 ? "You've reached your free AI limit (Rate Limit)." : `The AI is currently overloaded (Error ${code}).`;
        
        if (attempts < maxAttempts) {
          // Wait LONGER for 429 (Quota) errors specifically
          const baseWait = code === 429 ? 5000 : 2000;
          const waitTime = Math.pow(2, attempts) * baseWait + (Math.random() * 2000);
          Utilities.sleep(waitTime); 
          continue; 
        }
      }

      // Parse non-retryable or final error
      let errorMsg = text;
      try {
        const errorBody = JSON.parse(text);
        errorMsg = errorBody.error ? errorBody.error.message : text;
      } catch (f) {}
      throw new Error(`Gemini API Error (${code}): ${errorMsg}`);

    } catch (e) {
      if (e.toString().includes("Gemini API Error")) throw e;
      lastError = e.toString();
      if (attempts < maxAttempts) {
        Utilities.sleep(1000);
      }
    }
  }

  throw new Error(`Request failed after ${maxAttempts} attempts. Last Error: ${lastError}`);
}

/**
 * Generate Quiz from Text using Dynamic Model
 */
function generateQuizFromText(contextText, count, selectedModel) {
  const prompt = `Analyze the following context text and generate exactly ${count} educational multiple choice questions.
  
  CONTEXT TEXT:
  ${contextText}

  Output MUST be a raw JSON array of objects. 
  Each object MUST follow this schema: 
  {
    "question": "string",
    "options": ["string", "string", "string", "string"],
    "answer": integer (0-3 index),
    "category": "string (e.g., Pharmacology, Pathophysiology, Nursing Care, Safety, or Diagnostics)",
    "rationale": "string explanation"
  }
  Do not include any markdown formatting or explanations. Just the raw array.`;

  const rawContent = callGemini(prompt, selectedModel);
  
  // Robust Extraction
  const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("The AI didn't return a proper list of questions. Try pasting more text or different content.");
  }
  
  return JSON.parse(jsonMatch[0]);
}

/**
 * NEW: Explain Reviewer Content in simple terms
 */
function explainReviewerContent(contextText, selectedModel) {
  const prompt = `You are an expert nursing and medical tutor. Explain the following content in the absolute simplest way possible, using analogies and easy-to-understand language. 
  
  CONTEXT TEXT:
  ${contextText}

  RULES:
  1. Use bullet points for key concepts.
  2. Use "Simple Analogies" where possible.
  3. Keep the tone encouraging and professional.
  4. Format the output with clear headings and bold text for important terms.
  5. Provide a separate, final section at the very end labeled "---FLASHCARD---" containing exactly one ultra-concise, focused paragraph. 
     CRITICAL: Start the paragraph IMMEDIATELY. Do NOT use any introductory phrases like "Based on..." or "I will define...". 
     CRITICAL: This paragraph MUST NOT contain the name, title, or answer of the term being explained. Use generic terms like "This concept" or "This condition" instead. Remove all unnecessary filler words.`;

  return callGemini(prompt, selectedModel);
}

/**
 * NEW: Define a specific word within context
 */
function defineWord(word, contextText, selectedModel) {
  const prompt = `Define the word or term "[${word}]" specifically within the context of the medical/nursing text provided below. 
  
  CONTEXT TEXT:
  ${contextText}

  RULES:
  1. Provide a "Lyman's Terms" (simple) definition.
  2. Explain its clinical significance in this context.
  3. Give a short clinical example of its use.
  4. Use bold text for the word and its definition.
  5. Provide a separate, final section at the very end labeled "---FLASHCARD---" containing exactly one ultra-concise, focused paragraph. 
     CRITICAL: Start IMMEDIATELY. NO intro filler. The paragraph MUST NOT contain the name or answer of the term.`;

  return callGemini(prompt, selectedModel);
}

/**
 * Save questions to the Google Sheet (Currently Disabled)
 */
function saveToSheet(questions) {
  // Logic preserved but call is removed above
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName("Quiz");
    if (!sheet) {
      sheet = ss.insertSheet("Quiz");
      sheet.appendRow(["Question", "Option 1", "Option 2", "Option 3", "Option 4", "Answer Index", "Rationale"]);
    }
    
    questions.forEach(q => {
      sheet.appendRow([
        q.question, 
        q.options[0], 
        q.options[1], 
        q.options[2], 
        q.options[3], 
        q.answer, 
        q.rationale
      ]);
    });
  } catch (e) {
    console.log("Could not save to sheet: " + e.toString());
  }
}

/**
 * Fetches quiz data. Currently alternates between sample data 
 * and Google Sheet if a spreadsheet ID is provided.
 */
function getQuizData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Quiz');
    if (sheet) {
      const data = sheet.getDataRange().getValues();
      const headers = data.shift();
      return data.map(row => ({
        question: row[0],
        options: [row[1], row[2], row[3], row[4]],
        answer: row[5],
        rationale: row[6]
      }));
    }
  } catch (e) {
    console.warn("Could not load from sheet, using sample data.");
  }
  return getSampleQuestions();
}

/**
 * Helper to map 'A', 'B', 'C', 'D' to 0, 1, 2, 3.
 */
function getAnswerIndex(val) {
  const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  return map[val] ?? 0;
}

/**
 * Sample questions extracted from the provided text.
 */
function getSampleQuestions() {
  return [
    // --- Anatomy & Physiology (1-15) ---
    { 
      question: "Which division of the nervous system brings sensory information from the outside to the CNS?", 
      options: ["Efferent", "Afferent", "Somatic", "Autonomic"], 
      answer: 1,
      rationale: "The Afferent (Sensory) division brings information from visual, auditory, chemo, and touch receptors into the CNS." 
    },
    { 
      question: "A group of neuron cell bodies located outside the Central Nervous System is called a:", 
      options: ["Nucleus", "Dendrite", "Ganglion", "Synapse"], 
      answer: 2,
      rationale: "A ganglion is a collection of neuronal cell bodies in the PNS, whereas a nucleus is a similar collection within the CNS." 
    },
    { 
      question: "Which cells provide the myelin sheath in the Peripheral Nervous System?", 
      options: ["Oligodendrocytes", "Schwann cells", "Astrocytes", "Microglia"], 
      answer: 1,
      rationale: "Schwann cells myelinate axons in the PNS, while Oligodendrocytes perform this function in the CNS." 
    },
    { 
      question: "Which cells act as the 'brain's bouncer', strengthening the blood-brain barrier?", 
      options: ["Neurons", "Schwann cells", "Astrocytes", "Oligodendrocytes"], 
      answer: 2,
      rationale: "Astrocytes are star-shaped glial cells that provide structural support and help form the blood-brain barrier (BBB)." 
    },
    { 
      question: "The blood-brain barrier lets in which of the following molecules easily?", 
      options: ["Bacteria", "Large proteins", "Glucose and Oxygen", "Antibiotics"], 
      answer: 2,
      rationale: "The BBB is highly selective; it protects the brain from toxins but allows vital nutrients like Glucose and Oxygen to pass through." 
    },
    { 
      question: "Which lobe of the cerebrum is responsible for executive function and decision making?", 
      options: ["Frontal Lobe", "Parietal Lobe", "Temporal Lobe", "Occipital Lobe"], 
      answer: 0,
      rationale: "The Frontal Lobe manages high-level cognitive functions, motor control (Broca's area), and personality." 
    },
    { 
      question: "The parietal lobe is primarily responsible for:", 
      options: ["Vision", "Hearing", "Sensory information processing", "Decision making"], 
      answer: 2,
      rationale: "The Parietal Lobe handles somatosensory information, including touch, pressure, and spatial awareness." 
    },
    { 
      question: "Which brain structure helps send information from short-term to long-term memory?", 
      options: ["Hypothalamus", "Hippocampus", "Basal Gangalia", "Thalamus"], 
      answer: 1,
      rationale: "The Hippocampus is critical for forming new memories and connecting them to emotions/senses." 
    },
    { 
      question: "Which structure acts as a 'highway' allowing information to flow to and from the cerebral cortex?", 
      options: ["Internal Capsule", "Hypothalamus", "Medulla", "Pons"], 
      answer: 0,
      rationale: "The Internal Capsule is a white matter structure where massive amounts of motor and sensory fibers converge." 
    },
    { 
      question: "The Diencephalon is composed of which two parts?", 
      options: ["Pons and Medulla", "Thalamus and Hypothalamus", "Midbrain and Cerebellum", "Cerebrum and Brainstem"], 
      answer: 1,
      rationale: "The Diencephalon contains the Thalamus (relay station) and the Hypothalamus (homeostasis center)." 
    },
    { 
      question: "Which gland is known as the 'master gland' and hangs from the base of the brain?", 
      options: ["Adrenal", "Thyroid", "Pituitary", "Pineal"], 
      answer: 2,
      rationale: "The Pituitary gland, controlled by the hypothalamus, secretes hormones that affect almost every part of the body." 
    },
    { 
      question: "Which part of the brain is responsible for precision, balance, and muscle memory?", 
      options: ["Cerebrum", "Cerebellum", "Brainstem", "Thalamus"], 
      answer: 1,
      rationale: "The Cerebellum fine-tunes motor movements and maintains posture, balance, and coordination." 
    },
    { 
      question: "Which part of the brainstem contains nuclei that regulate blood pressure and breathing?", 
      options: ["Midbrain", "Pons", "Medulla", "Cerebellum"], 
      answer: 2,
      rationale: "The Medulla Oblongata is the vital center for autonomic functions like heart rate and respiration." 
    },
    { 
      question: "In a cross-section of the spinal cord, where is the grey matter located?", 
      options: ["On the outside", "On the inside (butterfly shape)", "In the meninges", "In the subarachnoid space"], 
      answer: 1,
      rationale: "In the spinal cord, grey matter (cell bodies) is internal, while white matter (axons) is external. This is the opposite of the brain." 
    },
    { 
      question: "The anterior (ventral) horns of the spinal cord are responsible for:", 
      options: ["Sensory information", "Autonomic regulation", "Voluntary motor movement", "Proprioception"], 
      answer: 2,
      rationale: "The anterior horns contain the cell bodies of lower motor neurons that trigger voluntary muscle contraction." 
    },

    // --- Meninges & Cranial Nerves (16-40) ---
    { 
      question: "What is the innermost layer of the meninges?", 
      options: ["Dura mater", "Arachnoid mater", "Pia mater", "Subarachnoid space"], 
      answer: 2,
      rationale: "The Pia Mater is the delicate, innermost layer that closely follows the contours of the brain." 
    },
    { 
      question: "Where is the Cerebrospinal Fluid (CSF) primarily housed?", 
      options: ["Epidural space", "Subdural space", "Subarachnoid space", "Dura mater"], 
      answer: 2,
      rationale: "CSF circulates within the Subarachnoid Space, located between the arachnoid and pia mater." 
    },
    { 
      question: "Cranial Nerve I is the:", 
      options: ["Optic nerve", "Olfactory nerve", "Oculomotor nerve", "Vagus nerve"], 
      answer: 1,
      rationale: "CN I is the Olfactory nerve, dedicated entirely to the sense of smell." 
    },
    { 
      question: "Which cranial nerve is tested by asking the patient to identify smells?", 
      options: ["CN I", "CN II", "CN III", "CN IV"], 
      answer: 0,
      rationale: "CN I (Olfactory) is tested using non-irritating clinical scents like coffee or vanilla." 
    },
    { 
      question: "Cranial Nerve II emerges from which part of the eye?", 
      options: ["Iris", "Retina", "Lens", "Cornea"], 
      answer: 1,
      rationale: "The Optic nerve (CN II) transmits visual information from the retina to the brain." 
    },
    { 
      question: "Which cranial nerve innervates the superior rectus muscle of the eye?", 
      options: ["CN II", "CN III", "CN IV", "CN VI"], 
      answer: 1,
      rationale: "CN III (Oculomotor) controls most eye muscles, including the superior rectus, inferior oblique, and pupillary constriction." 
    },
    { 
      question: "The Trochlear nerve (CN IV) innervates which muscle?", 
      options: ["Lateral rectus", "Superior oblique", "Inferior oblique", "Medial rectus"], 
      answer: 1,
      rationale: "CN IV exclusively innervates the Superior Oblique muscle, which depresses and rotates the eye inward." 
    },
    { 
      question: "Which cranial nerve is the largest and has three branches (Ophthalmic, Maxillary, Mandibular)?", 
      options: ["CN V (Trigeminal)", "CN VII (Facial)", "CN X (Vagus)", "CN XII (Hypoglossal)"], 
      answer: 0,
      rationale: "The Trigeminal nerve (CN V) provides facial sensation and controls the muscles of mastication (chewing)." 
    },
    { 
      question: "The Abducens nerve (CN VI) is responsible for which eye movement?", 
      options: ["Elevation", "Depression", "Abduction", "Adduction"], 
      answer: 2,
      rationale: "CN VI (Abducens) innervates the lateral rectus, which abducts the eye (moves it away from the midline)." 
    },
    { 
      question: "The Facial nerve (CN VII) exits the skull through which foramen?", 
      options: ["Foramen magnum", "Stylomastoid foramen", "Jugular foramen", "Optic canal"], 
      answer: 1,
      rationale: "CN VII (Facial) passes through the stylomastoid foramen and controls facial expression and taste for the anterior 2/3 of the tongue." 
    },
    { 
      question: "Which nerve is responsible for hearing and equilibrium?", 
      options: ["Glossopharyngeal", "Vestibulocochlear", "Vagus", "Accessory"], 
      answer: 1,
      rationale: "CN VIII (Vestibulocochlear) has two branches: one for hearing and one for balance." 
    },
    { 
      question: "The Glossopharyngeal nerve (CN IX) conveys taste from which part of the tongue?", 
      options: ["Anterior 2/3", "Posterior 1/3", "Tip only", "Sides only"], 
      answer: 1,
      rationale: "CN IX (Glossopharyngeal) handles taste and sensation for the posterior third of the tongue and the pharynx." 
    },
    { 
      question: "Which cranial nerve is the only one that extends beyond the head and neck into the thorax and abdomen?", 
      options: ["CN IX", "CN X (Vagus)", "CN XI", "CN XII"], 
      answer: 1,
      rationale: "The Vagus nerve (CN X) has a massive distribution, regulating heart rate, digestion, and respiratory rate." 
    },
    { 
      question: "The Accessory nerve (CN XI) innervates which two muscles?", 
      options: ["Biceps and Triceps", "Trapezius and Sternocleidomastoid", "Masseter and Temporalis", "Diaphragm and Intercostals"], 
      answer: 1,
      rationale: "CN XI (Accessory) is tested by shrugging the shoulders (trapezius) and turning the head (SCM)." 
    },
    { 
      question: "Cranial Nerve XII (Hypoglossal) controls which function?", 
      options: ["Vision", "Hearing", "Tongue movement", "Facial expression"], 
      answer: 2,
      rationale: "CN XII (Hypoglossal) is purely motor, moving the tongue for speech and swallowing." 
    },
    { 
      question: "A mnemonic for the names of the cranial nerves starts with:", 
      options: ["On Old Olympus...", "Some Say Marry...", "Every Good Boy...", "King Philip Came..."], 
      answer: 0,
      rationale: "Common mnemonics like 'On Old Olympus Towering Top' help recall Olfactory, Optic, Oculomotor, etc." 
    },
    { 
      question: "The 'Somatic' nervous system primarily controls:", 
      options: ["Smooth muscles", "Skeletal muscles", "Glands", "Internal organs"], 
      answer: 1,
      rationale: "The Somatic nervous system is voluntary and governs skeletal muscle contraction and sensory feedback." 
    },
    { 
      question: "The 'Autonomic' nervous system consists of which two divisions?", 
      options: ["CNS and PNS", "Brain and Spinal Cord", "Sympathetic and Parasympathetic", "Afferent and Efferent"], 
      answer: 2,
      rationale: "The ANS is involuntary and splits into the Sympathetic (stress) and Parasympathetic (relax) systems." 
    },
    { 
      question: "The 'Fight or Flight' response is controlled by the:", 
      options: ["Somatic System", "Sympathetic System", "Parasympathetic System", "Limbic System"], 
      answer: 1,
      rationale: "The Sympathetic Nervous System increases heart rate and diverts blood to muscles during stressful situations." 
    },
    { 
      question: "Which system is referred to as 'Rest and Digest'?", 
      options: ["Sympathetic", "Parasympathetic", "Somatic", "Afferent"], 
      answer: 1,
      rationale: "The Parasympathetic Nervous System conserves energy and maintains basic body functions like digestion." 
    },
    { 
      question: "How many pairs of spinal nerves are in the thoracic region?", 
      options: ["8", "12", "5", "1"], 
      answer: 1,
      rationale: "There are 12 pairs of thoracic nerves, corresponding to the 12 thoracic vertebrae." 
    },
    { 
      question: "Which nerve division brings motor information from the CNS to the periphery?", 
      options: ["Afferent", "Efferent", "Sensory", "Internal"], 
      answer: 1,
      rationale: "Efferent (Motor) nerves exit the CNS to trigger an effect in muscles or glands." 
    },
    { 
      question: "The space where two neurons communicate via neurotransmitters is the:", 
      options: ["Axon", "Dendrite", "Synapse", "Cell Body"], 
      answer: 2,
      rationale: "The Synapse is the junction where the axon of one neuron meets the dendrite of another." 
    },
    { 
      question: "Which glial cells are only present in the CNS and provide structural support?", 
      options: ["Schwann cells", "Astrocytes", "Oligodendrocytes", "Satellite cells"], 
      answer: 1,
      rationale: "Astrocytes are specific to the CNS; they are the most abundant glial cells and form the BBB." 
    },
    { 
      question: "Which brain lobe is responsible for hearing, smell, and memory?", 
      options: ["Frontal", "Parietal", "Temporal", "Occipital"], 
      answer: 2,
      rationale: "The Temporal Lobe houses the auditory cortex and areas vital for memory (hippocampus) and emotion." 
    },

    // --- Assessment & Diagnostics (41-70) ---
    { 
      question: "A change in the Level of Consciousness (LOC) is the ___ indication of declining neurologic function.", 
      options: ["First", "Last", "Secondary", "Minor"], 
      answer: 0,
      rationale: "LOC is the most sensitive and earliest indicator of neurological changes." 
    },
    { 
      question: "What is the very first sign of neurologic decline listed in the assessment?", 
      options: ["Coma", "Restlessness", "Bradycardia", "Pupil dilation"], 
      answer: 1,
      rationale: "Restlessness, irritability, or agitation often precede more obvious symptoms like coma or pupil changes." 
    },
    { 
      question: "The Glasgow Coma Scale (GCS) assesses which three responses?", 
      options: ["Eye, Motor, Verbal", "Eye, Motor, Pain", "Verbal, Pain, Reflex", "Motor, Pulse, Respiration"], 
      answer: 0,
      rationale: "GCS evaluates Eye Opening (1-4), Verbal Response (1-5), and Motor Response (1-6)." 
    },
    { 
      question: "In GCS, a score of 3-8 is interpreted as:", 
      options: ["Mild", "Moderate", "Severe", "Normal"], 
      answer: 2,
      rationale: "An 8 or less is generally the threshold for severe injury and often necessitates intubation ('GCS 8, intubate')." 
    },
    { 
      question: "Which diagnostic test uses magnetic fields and radio waves and is non-invasive?", 
      options: ["CT Scan", "X-ray", "MRI", "PET Scan"], 
      answer: 2,
      rationale: "MRI provides high-resolution images of soft tissues without using ionizing radiation." 
    },
    { 
      question: "A sensor in a PET scan measures which particles colliding?", 
      options: ["Protons and Neutrons", "Positrons and Electrons", "Alpha and Beta", "Photons and Ions"], 
      answer: 1,
      rationale: "PET scans detect gamma rays produced when positrons from a radioactive tracer collide with electrons in tissues." 
    },
    { 
      question: "Which color indicates the highest intensity/activity in a PET scan image?", 
      options: ["Blue", "Green", "Yellow", "Red"], 
      answer: 3,
      rationale: "Red indicates metabolic 'hot spots' with high glucose uptake, while blue/purple represent low activity." 
    },
    { 
      question: "What is a major contraindication for MRI?", 
      options: ["Allergy to shellfish", "Permanent Pacemaker", "NPO status", "History of asthma"], 
      answer: 1,
      rationale: "The powerful magnets in an MRI can displace or malfunction metallic implants like pacemakers or shrapnel." 
    },
    { 
      question: "For which test should a patient avoid coffee, tea, and stimulants for 24-48 hours?", 
      options: ["MRI", "CT Scan", "EEG", "EMG"], 
      answer: 2,
      rationale: "Stimulants can alter the brain's electrical activity, potentially masking or mimicking abnormalities during an EEG." 
    },
    { 
      question: "Which test measures electrical activity of the superficial layers of the cerebral cortex?", 
      options: ["EEG", "EMG", "ECT", "EVP"], 
      answer: 0,
      rationale: "EEG (Electroencephalography) uses electrodes on the scalp to monitor brain wave patterns." 
    },
    { 
      question: "A Lumbar Puncture is typically performed at which interspace?", 
      options: ["L1-L2", "L3-L4", "T12-L1", "C1-C2"], 
      answer: 1,
      rationale: "L3-L4 or L4-L5 are used because the spinal cord ends higher up (at L1 or L2), minimizing the risk of injury." 
    },
    { 
      question: "What is the normal pressure for CSF (in mm of H2O)?", 
      options: ["10-50", "80-180", "200-300", "5-15"], 
      answer: 1,
      rationale: "Opening pressure during a lumbar puncture is normally between 80-180 mmH2O in the lateral decubitus position." 
    },
    { 
      question: "CSF analysis showing a glucose level of 40-80 mg/dL is:", 
      options: ["High", "Low", "Normal", "Critically low"], 
      answer: 2,
      rationale: "Normal CSF glucose is roughly 60% of blood glucose, usually ranging from 45-80 mg/dL." 
    },
    { 
      question: "Which diagnostic procedure involves injecting contrast into the cerebral arteries?", 
      options: ["CT Scan", "Cerebral Angiography", "Myelography", "EEG"], 
      answer: 1,
      rationale: "Angiography allows visualization of blood vessels to detect aneurysms, stenosis, or vascular malformations." 
    },
    { 
      question: "Myelography is used to examine the relationship between:", 
      options: ["Heart and Lungs", "Vertebrae and Discs", "Brain and Eyes", "Arteries and Veins"], 
      answer: 1,
      rationale: "Myelography involves injecting contrast into the subarachnoid space to view spinal cord compression or disc issues on X-rays." 
    },
    { 
      question: "In a 'Sleep Deprivation EEG', the patient is asked to:", 
      options: ["Sleep 12 hours", "Avoid sleeping the night before", "Take a sedative", "Drink caffeine"], 
      answer: 1,
      rationale: "Sleep deprivation lowers the seizure threshold, making it easier to capture abnormal electrical activity." 
    },
    { 
      question: "An EMG (Electromyography) measures the electrical activity of:", 
      options: ["Brain", "Heart", "Muscles", "Eyes"], 
      answer: 2,
      rationale: "EMG uses needle electrodes to assess the health of muscles and the nerve cells that control them." 
    },
    { 
      question: "Which test assesses if carotid artery blood flow is decreased or blocked?", 
      options: ["EEG", "Transcranial Doppler", "MRI", "Myelography"], 
      answer: 1,
      rationale: "TCD uses ultrasound to measure blood flow velocity in the major cerebral arteries." 
    },
    { 
      question: "Evoked Potentials (EVP) measure brain response to:", 
      options: ["Exercise", "Sensory stimulation", "Deep sleep", "Medication"], 
      answer: 1,
      rationale: "EVPs track the speed and path of nerve signals as they travel to the brain in response to sight, sound, or touch." 
    },
    { 
      question: "Vibratory sensation is tested using a:", 
      options: ["Reflex hammer", "Cotton ball", "Tuning fork", "Tongue blade"], 
      answer: 2,
      rationale: "A 128 Hz tuning fork is placed on bony prominences (like the toe or finger) to test the dorsal column pathway." 
    },
    { 
      question: "The ability to identify a familiar object by touch (with eyes closed) is:", 
      options: ["Graphesthesia", "Stereognosis", "Proprioception", "Ataxia"], 
      answer: 1,
      rationale: "Stereognosis tests the parietal lobe's ability to integrate sensory texture and shape and recognize an object." 
    },
    { 
      question: "Graphesthesia is the ability to identify:", 
      options: ["Colors", "Shapes", "Numbers/Characters written on skin", "Smells"], 
      answer: 2,
      rationale: "Graphesthesia is another test for the parietal lobe, identifying digits or letters 'drawn' on the palm." 
    },
    { 
      question: "A Romberg test is used to assess:", 
      options: ["Hearing", "Vision", "Balance and Equilibrium", "Muscle strength"], 
      answer: 2,
      rationale: "A positive Romberg (swaying when eyes are closed) suggests an issue with proprioception or vestibular function." 
    },
    { 
      question: "In reflex testing, a grade of '2+' is considered:", 
      options: ["No response", "Diminished", "Normal", "Hyperactive"], 
      answer: 2,
      rationale: "The standard scale for Deep Tendon Reflexes is 0 (absent) to 4+ (hyperactive with clonus), where 2+ is the normal expected finding." 
    },
    { 
      question: "Testing rapid alternating movements assesses which brain function?", 
      options: ["Cerebral", "Cerebellar", "Brainstem", "Thalamic"], 
      answer: 1,
      rationale: "Coordination and rhythm are key functions of the cerebellum." 
    },
    { 
      question: "Dysdiadochokinesis refers to:", 
      options: ["Loss of vision", "Slow/Uncoordinated alternating movements", "Inability to speak", "Numbness in hands"], 
      answer: 1,
      rationale: "This is a clinical sign of cerebellar dysfunction, where the patient cannot perform rapid, alternating movements smoothly." 
    },
    { 
      question: "Which reflex is tested by striking the tendon above the olecranon process?", 
      options: ["Biceps", "Triceps", "Brachioradialis", "Achilles"], 
      answer: 1,
      rationale: "The Triceps reflex involves striking the triceps tendon, causing extension of the elbow (innervated by C7-C8)." 
    },
    { 
      question: "The Achilles reflex evaluates which function?", 
      options: ["Dorsiflexion", "Plantar flexion", "Elbow flexion", "Knee extension"], 
      answer: 1,
      rationale: "Striking the Achilles tendon causes the gastrocnemius muscle to contract, pulling the foot downward (Plantar flexion)." 
    },
    { 
      question: "Clonus is described as:", 
      options: ["Muscle weakness", "Involuntary contraction and relaxation", "Loss of sensation", "Sharp pain"], 
      answer: 1,
      rationale: "Clonus is a sign of an upper motor neuron lesion, characterized by rhythmic, oscillatory muscle movements." 
    },
    { 
      question: "The 'Babinski reflex' is not mentioned in detail, but which tool is used for all DTRs?", 
      options: ["Stethoscope", "Tuning Fork", "Reflex Hammer", "Otoscope"], 
      answer: 2,
      rationale: "A reflex hammer is essential to deliver a standardized tap to the tendon to evoke a muscle twitch." 
    },

    // --- ICP, Receptors, & Seizures (71-100) ---
    { 
      question: "Increased Intracranial Pressure (ICP) is defined as pressure exceeding:", 
      options: ["5 mmHg", "10 mmHg", "20 mmHg", "50 mmHg"], 
      answer: 2,
      rationale: "Normal ICP is 5-15 mmHg; sustained levels above 20 mmHg are considered pathological and require intervention." 
    },
    { 
      question: "The Monro-Kellie Doctrine states that the total volume of brain, blood, and ___ is constant.", 
      options: ["Air", "Oxygen", "CSF", "Water"], 
      answer: 2,
      rationale: "The doctrine explains that a change in any of these three volumes must be compensated by the others to maintain ICP." 
    },
    { 
      question: "Cushing's Triad includes irregular breathing, bradycardia, and:", 
      options: ["Hypotension", "Systolic Hypertension", "Tachycardia", "Pupil constriction"], 
      answer: 1,
      rationale: "Cushing's Triad is a late sign of high ICP, reflecting brainstem compression." 
    },
    { 
      question: "What is the pressure gradient across the brain called?", 
      options: ["MAP", "ICP", "CPP", "GCS"], 
      answer: 2,
      rationale: "CPP = MAP - ICP. It represents the pressure needed to provide blood flow to the brain tissue." 
    },
    { 
      question: "Normal Cerebral Perfusion Pressure (CPP) range is:", 
      options: ["40-60", "70-100", "120-140", "10-20"], 
      answer: 1,
      rationale: "Maintaining CPP above 70 mmHg is critical to ensure the brain receives enough oxygen and nutrients." 
    },
    { 
      question: "Hyperventilation helps lower ICP by causing:", 
      options: ["Vasodilation", "Vasoconstriction", "Increased CSF", "Decreased Heart Rate"], 
      answer: 1,
      rationale: "Lowering CO2 levels causes cerebral vasoconstriction, which reduce blood volume in the brain and thus lowers ICP." 
    },
    { 
      question: "Which medication is a hyperosmolar diuretic used to reduce brain swelling?", 
      options: ["Dexamethasone", "Mannitol", "Phenytoin", "Diazepam"], 
      answer: 1,
      rationale: "Mannitol creates an osmotic gradient that pulls water out of brain tissue and into the blood vessels." 
    },
    { 
      question: "Adrenergic receptors bind with which neurotransmitters?", 
      options: ["Acetylcholine", "Catecholamines", "GABA", "Glutamate"], 
      answer: 1,
      rationale: "Adrenergic receptors respond to Norepinephrine and Epinephrine, the primary sympathetic neurotransmitters." 
    },
    { 
      question: "Which adrenergic receptor subtype is coupled with a Gi protein (inhibitory)?", 
      options: ["Alpha1", "Alpha2", "Beta1", "Beta2"], 
      answer: 1,
      rationale: "Alpha2 receptors are inhibitory and are typically found on presynaptic nerve endings to provide feedback inhibition." 
    },
    { 
      question: "Acetylcholine binds to which two types of receptors?", 
      options: ["Alpha and Beta", "Nicotinic and Muscarinic", "Gq and Gs", "NMDA and GABA"], 
      answer: 1,
      rationale: "Acetylcholine (ACh) receptors are divided into fast-acting Nicotinic and slower-acting Muscarinic types." 
    },
    { 
      question: "The main excitatory neurotransmitter in the brain is:", 
      options: ["GABA", "Glutamate", "Acetylcholine", "Dopamine"], 
      answer: 1,
      rationale: "Glutamate triggers most of the brain's excitatory activity and is involved in memory and learning." 
    },
    { 
      question: "The main inhibitory neurotransmitter in the brain is:", 
      options: ["Glutamate", "GABA", "Adrenaline", "Serotonin"], 
      answer: 1,
      rationale: "GABA (Gamma-Aminobutyric Acid) acts as the 'brake' to prevent neuronal over-excitation." 
    },
    { 
      question: "A seizure that affects only one hemisphere of the brain is called:", 
      options: ["Generalized", "Partial or Focal", "Tonic-clonic", "Absence"], 
      answer: 1,
      rationale: "Focal seizures originate in a specific lobe or region of one hemisphere." 
    },
    { 
      question: "A simple partial seizure involves:", 
      options: ["Loss of consciousness", "Preserved consciousness", "Full body jerking", "Postictal coma"], 
      answer: 1,
      rationale: "In a 'simple' focal seizure, the patient remains awake and aware of their surroundings." 
    },
    { 
      question: "What was the former name for a Tonic-Clonic seizure?", 
      options: ["Petit Mal", "Grand Mal", "Atypical", "Focal"], 
      answer: 1,
      rationale: "Grand Mal seizures involve the entire brain and result in full-body stiffness and jerking." 
    },
    { 
      question: "A seizure characterized by a brief 'blank stare' (common in children) is:", 
      options: ["Tonic-clonic", "Absence", "Myoclonic", "Atonic"], 
      answer: 1,
      rationale: "Absence (Petit Mal) seizures are brief lapses in awareness without muscle jerking." 
    },
    { 
      question: "Status Epilepticus is considered a medical emergency if it lasts over:", 
      options: ["1 minute", "5 minutes", "30 minutes", "1 hour"], 
      answer: 1,
      rationale: "Prolonged seizure activity (Status) can lead to hypoxia and permanent brain damage." 
    },
    { 
      question: "The 'postictal state' refers to the period ___ a seizure.", 
      options: ["Before", "During", "After", "Between"], 
      answer: 2,
      rationale: "After a seizure, patients are often confused, lethargic, or deeply asleep as the brain recovers." 
    },
    { 
      question: "Todd's Paralysis is a temporary weakness following a:", 
      options: ["Stroke", "Seizure", "Migraine", "Faint"], 
      answer: 1,
      rationale: "This transient postictal focal deficit can mimic a stroke but usually resolves within 24 hours." 
    },
    { 
      question: "First-line medication for Status Epilepticus is often:", 
      options: ["Mannitol", "Benzodiazepines", "Aspirin", "Insulin"], 
      answer: 1,
      rationale: "Drugs like Diazepam or Lorazepam help terminate acute seizure activity quickly." 
    },
    { 
      question: "Which diet is sometimes used to help control seizures in some patients?", 
      options: ["DASH diet", "Ketogenic diet", "Low sodium diet", "High protein diet"], 
      answer: 1,
      rationale: "A high-fat, low-carbohydrate Keto diet alters brain metabolism and can reduce seizure frequency." 
    },
    { 
      question: "Febrile seizures are most common in children between:", 
      options: ["0-3 months", "6 months - 5 years", "10-15 years", "Adulthood"], 
      answer: 1,
      rationale: "Febrile seizures are caused by rapid rises in temperature and are usually benign." 
    },
    { 
      question: "Which receptor is primary in responding to Glutamate in the brain?", 
      options: ["GABA", "NMDA", "Nicotinic", "Adrenergic"], 
      answer: 1,
      rationale: "NMDA receptors are key to neuronal excitability and synaptic plasticity." 
    },
    { 
      question: "What is a 'Jacksonian March'?", 
      options: ["A military drill", "Seizure activity spreading from one muscle group to others", "A diagnostic test", "A type of gait"], 
      answer: 1,
      rationale: "This occurs during focal motor seizures as the electrical discharge 'marches' along the motor cortex." 
    },
    { 
      question: "What is an 'Aura' in the context of seizures?", 
      options: ["Postictal sleep", "An unusual sensation preceding a seizure", "A diagnostic tool", "A surgical procedure"], 
      answer: 1,
      rationale: "An aura (like a specific smell or light) is actually the first part of a focal seizure." 
    },
    { 
      question: "A generalized seizure affecting both hemispheres is referred to as:", 
      options: ["Focal", "Generalized", "Unilateral", "Local"], 
      answer: 1,
      rationale: "Generalized seizures result from abnormal activity throughout both halves of the brain." 
    },
    { 
      question: "The 'tonic' phase of a seizure involves:", 
      options: ["Rhythmic jerking", "Rigid muscle stiffening", "Flaccid muscles", "Daydreaming"], 
      answer: 1,
      rationale: "In the tonic-clonic sequence, 'tonic' means the muscles are in a state of high tension or contraction." 
    },
    { 
      question: "Loss of consciousness during a seizure is common in which type?", 
      options: ["Simple Partial", "Complex Partial", "Myoclonic", "Aura phase"], 
      answer: 1,
      rationale: "In Complex Partial seizures, consciousness is impaired or lost, often accompanied by automatisms." 
    },
    { 
      question: "The primary complication of Status Epilepticus is:", 
      options: ["Tongue biting", "Permanent brain damage", "Bruisng", "Headache"], 
      answer: 1,
      rationale: "Due to high metabolic demand and potential airway issues, it is a life-threatening emergency." 
    },
    { 
      question: "Which neurotransmitter is deficient or inhibited by GABA receptors?", 
      options: ["Excitatory signals", "Inhibitory signals", "Muscle signals", "Visual signals"], 
      answer: 0,
      rationale: "GABA works by inhibiting or slowing down excitatory neurons to maintain balance." 
    },

    // --- CVA / Stroke (101-120) ---
    { 
      question: "What are the two main types of stroke?", 
      options: ["Ischemic and Hemorrhagic", "Tonic and Clonic", "Partial and Focal", "Acute and Chronic"], 
      answer: 0,
      rationale: "Stroke results from either a loss of blood flow (Ischemic) or bleeding into the brain (Hemorrhagic)." 
    },
    { 
      question: "Which type of stroke is caused by a blocked artery?", 
      options: ["Hemorrhagic", "Ischemic", "Subarachnoid", "Aneurysm"], 
      answer: 1,
      rationale: "Ischemic strokes account for ~85% of all strokes and are usually caused by clots." 
    },
    { 
      question: "A 'Transient Ischemic Attack' (TIA) usually resolves within:", 
      options: ["1 hour", "24 hours", "1 week", "1 month"], 
      answer: 1,
      rationale: "TIAs are 'warning strokes' where clinical symptoms reverse quickly but indicate high future stroke risk." 
    },
    { 
      question: "The Circle of Willis is a ring of arteries that:", 
      options: ["Filters CSF", "Provides alternative blood supply routes", "Controls the heartbeat", "Secretes hormones"], 
      answer: 1,
      rationale: "Collateral circulation allows blood to bypass blockages, potentially sparing brain tissue." 
    },
    { 
      question: "What is the most common irritant/risk factor for atherosclerosis in stroke?", 
      options: ["Sugar", "Tobacco toxins", "Vitamin C", "Caffeine"], 
      answer: 1,
      rationale: "Chemicals in tobacco smoke damage the arterial lining, promoting plaque buildup and clotting." 
    },
    { 
      question: "Which term refers to brain tissue that is potentially salvageable after a stroke?", 
      options: ["Infarction core", "Penumbra", "Liquefactive zone", "Grey matter"], 
      answer: 1,
      rationale: "The penumbra is the 'at risk' zone around the dead core. Timely treatment can save this tissue." 
    },
    { 
      question: "What is the gold standard clot-busting medication for ischemic stroke?", 
      options: ["Insulin", "TPA (Tissue Plasminogen Activator)", "Warfarin", "Mannitol"], 
      answer: 1,
      rationale: "TPA must be given as soon as possible after symptom onset to dissolve the obstructing clot." 
    },
    { 
      question: "The FAST acronym 'S' stands for:", 
      options: ["Strength", "Sight", "Speech difficulties", "Sensation"], 
      answer: 2,
      rationale: "FAST stands for Face (drooping), Arm (weakness), Speech (slurred), and Time (to call emergency)." 
    },
    { 
      question: "Subarachnoid Hemorrhage (SAH) is often described as the '___ ever headache'.", 
      options: ["Shortest", "Weakest", "Worst", "Most common"], 
      answer: 2,
      rationale: "This describes the intense, sudden onset pain caused by blood irritating the meninges." 
    },
    { 
      question: "A 'Thunderclap headache' is a classic symptom of:", 
      options: ["Migraine", "Subarachnoid Hemorrhage", "Ischemic Stroke", "Epilepsy"], 
      answer: 1,
      rationale: "A thunderclap headache reaches peak intensity within seconds and is a neurosurgical emergency." 
    },
    { 
      question: "Which condition involves bleeding between the pia mater and arachnoid mater?", 
      options: ["Intracerebral Hemorrhage", "Subarachnoid Hemorrhage", "Epidural Hematoma", "Subdural Hematoma"], 
      answer: 1,
      rationale: "This is where the major cerebral blood vessels sit, leading to rapid contamination of the CSF with blood." 
    },
    { 
      question: "A berry aneurysm rupture most often causes which type of stroke?", 
      options: ["Ischemic", "Intraparenchymal", "Subarachnoid Hemorrhage", "Lacunar"], 
      answer: 2,
      rationale: "Berry (Saccular) aneurysms are common in the Circle of Willis; their rupture release blood into the subarachnoid space." 
    },
    { 
      question: "Which side of the body is affected if the stroke occurs in the right cerebral hemisphere?", 
      options: ["Right side", "Left side", "Both sides", "Lower body only"], 
      answer: 1,
      rationale: "Motor neurons cross over (decussate) in the medulla, so the right brain controls the left body." 
    },
    { 
      question: "Aphasia (difficulty speaking) often occurs when which lobe is damaged?", 
      options: ["Right frontal", "Left frontal (Broca's)", "Right occipital", "Left parietal"], 
      answer: 1,
      rationale: "In 95% of people, language centers are in the left hemisphere, specifically Broca's area for production." 
    },
    { 
      question: "Wernicke's area damage results in difficulty with:", 
      options: ["Motor movement", "Understanding speech", "Vision", "Smell"], 
      answer: 1,
      rationale: "Wernicke's aphasia describes the inability to comprehend spoken or written language." 
    },
    { 
      question: "Homonymous hemianopsia is a deficit in:", 
      options: ["Hearing", "Vision", "Touch", "Balance"], 
      answer: 1,
      rationale: "This is the loss of the same half of the visual field in both eyes due to damage to the optic tract or occipital lobe." 
    },
    { 
      question: "A 'Locked-in Syndrome' can occur from a stroke in the:", 
      options: ["Cerebrum", "Basilar artery/Brainstem", "Thalamus", "Optic nerve"], 
      answer: 1,
      rationale: "Damage to the ventral pons leaves the patient conscious but paralyzed, able to move only their eyes." 
    },
    { 
      question: "Which type of necrosis occurs in damaged brain tissue after a stroke?", 
      options: ["Coagulative", "Liquefactive", "Caseous", "Fatty"], 
      answer: 1,
      rationale: "The high lipid content of the brain causes it to turn into a liquid mass after cell death." 
    },
    { 
      question: "Increased Intracranial Pressure after a stroke can lead to:", 
      options: ["Brain Herniation", "Improved blood flow", "Faster recovery", "Weight loss"], 
      answer: 0,
      rationale: "Tissue swelling (edema) after a stroke pushes the brain through the foramen magnum, which is fatal." 
    },
    { 
      question: "A 'Lacunar Stroke' typically involves deep branches of the:", 
      options: ["Internal Carotid", "Vertebral Artery", "Middle Cerebral Artery", "Basilar Artery"], 
      answer: 2,
      rationale: "These small, deep-vessel strokes (perforating branches of the MCA) often present with pure motor or pure sensory deficits." 
    }
  ];
}
