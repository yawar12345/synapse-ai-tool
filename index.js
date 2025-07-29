// index.js - The Complete and Fully Functional Backend Server

// --- 1. Import Dependencies ---
require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Import the cors package
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
// --- We no longer need to import the browser package directly ---

// --- 2. Initialize Express App ---
const app = express();
const port = 3000;
app.use(cors()); // --- FIX: Enable CORS for all requests ---
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- 3. Initialize Gemini AI ---
if (!process.env.GEMINI_API_KEY) {
    console.error("\nFATAL ERROR: GEMINI_API_KEY is not found in .env file.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });


// --- NEW: Resilient AI Call Helper with Retry Logic ---
async function generateContentWithRetry(prompt, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await aiModel.generateContent(prompt);
            return result;
        } catch (error) {
            // Check if the error is a 503 Service Unavailable
            if (error.status === 503 && i < retries - 1) {
                console.warn(`AI model is overloaded. Retrying in ${delay / 1000}s... (Attempt ${i + 1})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                // For other errors or last retry, throw the error
                throw error;
            }
        }
    }
}


// --- 4. API Endpoint to Run Tests ---
app.post('/api/run-test', async (req, res) => {
    console.log("Received test execution request...");
    const { steps } = req.body;
    if (!steps) return res.status(400).json({ error: 'Test steps are required.' });

    const resultsLog = [];
    try {
        const prompt = `You are a highly intelligent and precise language-to-JSON converter for a test automation system. Your ONLY job is to convert the user's plain English steps into a structured JSON array based on the strict rules below.

        **Rules:**
        1.  Analyze each line of the user's input to determine the core action.
        2.  Map the action to one of the following official command objects. Be flexible with synonyms.

        **Command Mapping:**
        -   If the user says "navigate", "go to", "open", or "visit" a URL, you MUST create this object:
            \`{ "action": "navigate", "url": "THE_URL" }\`
        -   If the user says "click", "press", or "tap" an element, you MUST create this object:
            \`{ "action": "click", "selector": "THE_CSS_SELECTOR" }\`
        -   If the user says "type", "fill", "enter", "input", or "write" text, you MUST create this object:
            \`{ "action": "type", "selector": "THE_CSS_SELECTOR", "text": "THE_TEXT" }\`
        -   If the user says "check", "assert", "verify", "see", or "find" an element, you MUST create this object:
            \`{ "action": "assertVisible", "selector": "THE_CSS_SELECTOR_OR_TEXT_SELECTOR" }\`
        -   If the user says "wait", "pause", "sleep", or "delay", you MUST create this object:
            \`{ "action": "wait", "duration": THE_MILLISECONDS }\`

        **Selector Rules:**
        -   For finding elements by their text content, you MUST use the format: \`"selector": "text=The exact text"\`.
        -   For all other elements, use standard CSS selectors (e.g., \`input[name="email"]\`).
        -   **NEVER** use non-standard selectors like \`:contains()\`. It is invalid.

        **Example:**
        User Input:
        \`navigate https://google.com\`
        \`type "testing" in the search bar\`

        Your Correct JSON Output:
        [
          { "action": "navigate", "url": "https://google.com" },
          { "action": "type", "selector": "[aria-label='Search']", "text": "testing" }
        ]

        Now, convert the following user steps. Respond ONLY with the JSON array, nothing else.

        **User Steps:**
        ${steps}
        `;
        const aiResult = await generateContentWithRetry(prompt); // Use the new retry function
        const jsonText = aiResult.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        
        let commands;
        try {
            commands = JSON.parse(jsonText);
            resultsLog.push({ status: 'info', message: 'AI successfully translated steps to JSON.' });
        } catch (e) {
            throw new Error(`AI returned invalid JSON. Response: ${jsonText}`);
        }

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        resultsLog.push({ status: 'info', message: 'Browser launched.' });

        for (const command of commands) {
            try {
                switch (command.action) {
                    case 'navigate':
                        await page.goto(command.url, { timeout: 15000 });
                        resultsLog.push({ status: 'success', message: `Navigated to ${command.url}` });
                        break;
                    case 'click':
                        await page.locator(command.selector).click({ timeout: 10000 });
                        resultsLog.push({ status: 'success', message: `Clicked: '${command.selector}'` });
                        break;
                    case 'type':
                        await page.locator(command.selector).fill(command.text);
                        resultsLog.push({ status: 'success', message: `Typed "${command.text}" into '${command.selector}'` });
                        break;
                    case 'assertVisible':
                        const element = page.locator(command.selector);
                        await element.waitFor({ state: 'visible', timeout: 10000 });
                        resultsLog.push({ status: 'success', message: `Asserted visible: '${command.selector}'` });
                        break;
                    case 'wait':
                        await page.waitForTimeout(command.duration);
                        resultsLog.push({ status: 'info', message: `Waited for ${command.duration}ms` });
                        break;
                    default: throw new Error(`Unknown command: ${command.action}`);
                }
            } catch (error) {
                const errorMessage = `Failed on action '${command.action}'. Error: ${error.message.split('\n')[0]}`;
                resultsLog.push({ status: 'error', message: errorMessage });
                await browser.close();
                return res.status(200).json({ log: resultsLog });
            }
        }
        await browser.close();
        res.status(200).json({ log: resultsLog });
    } catch (error) {
        console.error('Error during test run:', error);
        resultsLog.push({ status: 'error', message: `A critical server error occurred: ${error.message}` });
        res.status(500).json({ log: resultsLog });
    }
});

// --- 5. API Endpoint for Recording (STABLE VERSION) ---
app.post('/api/record', (req, res) => {
    console.log("Received recording request (exec method)...");
    const { startUrl, generateUI, generateJMX, framework, language } = req.body;
    if (!startUrl) return res.status(400).json({ error: 'Starting URL is required.' });

    const tempCodeFile = path.join(os.tmpdir(), `codegen-${Date.now()}.js`);
    const harFile = generateJMX ? path.join(os.tmpdir(), `network-${Date.now()}.har`) : null;

    let command = `npx playwright codegen "${startUrl}" --target javascript -o "${tempCodeFile}"`;
    if (harFile) {
        command += ` --save-har="${harFile}"`;
    }

    console.log(`Executing command: ${command}`);

    let stderrData = '';
    const codegenProcess = exec(command);

    codegenProcess.stderr.on('data', (data) => {
        console.error(`Codegen stderr: ${data}`);
        stderrData += data;
    });

    codegenProcess.on('exit', async (code) => {
        console.log(`Codegen process exited with code ${code}.`);
        
        if (code !== 0) {
            const errorMessage = `Recording session failed. Details: ${stderrData || 'The browser may have closed unexpectedly or the URL was invalid.'}`;
            return res.status(500).json({ error: errorMessage });
        }
        
        console.log("Processing successful recording...");

        try {
            let uiScript = "";
            if (generateUI) {
                try {
                    const playwrightCode = await fs.readFile(tempCodeFile, 'utf-8');
                    if (playwrightCode) {
                        const prompt = `You are an expert Test Automation Engineer. Convert a recorded Playwright script into a clean, runnable test script for the framework "${framework}" and language "${language}". The script must be complete, including all necessary imports and boilerplate. Respond ONLY with the raw code. SOURCE SCRIPT: \`\`\`javascript\n${playwrightCode}\n\`\`\``;
                        const aiResult = await generateContentWithRetry(prompt); // Use the new retry function
                        uiScript = aiResult.response.text().trim().replace(/```[\w\s]*\n/g, '').replace(/```/g, '');
                        console.log(`Generated UI script for ${framework}/${language}.`);
                    }
                } catch (readError) {
                    console.warn("Could not read codegen output file:", readError.message);
                    uiScript = "// No UI actions were recorded.";
                }
            }

            let jmxFileContent = "";
            if (generateJMX && harFile) {
                try {
                    const harContent = await fs.readFile(harFile, 'utf-8');
                    const harJson = JSON.parse(harContent);
                    const requests = harJson.log.entries.map(entry => entry.request);
                    jmxFileContent = generateJmxFromRequests(requests);
                    console.log("Generated JMX file content.");
                } catch (harError) {
                    console.error("Could not read or parse HAR file:", harError.message);
                }
            }

            await fs.unlink(tempCodeFile).catch(e => console.error("Error deleting temp codegen file:", e.message));
            if (harFile) {
                await fs.unlink(harFile).catch(e => console.error("Error deleting temp HAR file:", e.message));
            }

            res.status(200).json({ uiScript, jmxFileContent });

        } catch (error) {
            console.error('Error processing recording results:', error);
            res.status(500).json({ error: `Failed to process recording: ${error.message}` });
        }
    });
});


// --- 6. API Endpoint for AI Test Case Generation ---
app.post('/api/generate-cases', async (req, res) => {
    console.log("Received test case generation request...");
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'A description is required.' });

    try {
        const prompt = `You are a Senior QA Engineer. Based on the following feature description, generate a comprehensive list of test steps in plain English. The steps should be clear, concise, and ready to be executed. Each step should be on a new line. FEATURE DESCRIPTION: "${description}" TEST STEPS:`;
        const aiResult = await generateContentWithRetry(prompt); // Use the new retry function
        const generatedSteps = aiResult.response.text().trim();
        
        console.log("Generated test cases.");
        res.status(200).json({ steps: generatedSteps });

    } catch (error) {
        console.error('Error generating test cases:', error);
        res.status(500).json({ error: `Failed to generate test cases: ${error.message}` });
    }
});


// --- 7. Helper to Generate JMX File ---
function generateJmxFromRequests(requests) {
    const threadGroup = requests.map((req) => {
        const url = new URL(req.url);
        if (['.css', '.js', '.png', '.jpg', '.gif', '.svg', '.woff', '.ico'].some(ext => url.pathname.endsWith(ext))) {
            return '';
        }

        return `
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${req.method} ${url.pathname.substring(0, 100)}" enabled="true">
          <stringProp name="HTTPSampler.domain">${url.hostname}</stringProp>
          <stringProp name="HTTPSampler.port">${url.port || (url.protocol === 'https:' ? '443' : '80')}</stringProp>
          <stringProp name="HTTPSampler.protocol">${url.protocol.slice(0, -1)}</stringProp>
          <stringProp name="HTTPSampler.path">${url.pathname}${url.search}</stringProp>
          <stringProp name="HTTPSampler.method">${req.method}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>
        </HTTPSamplerProxy>
        <hashTree/>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.4.1">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="Recorded API Test" enabled="true">
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="User Group" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">1</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">false</boolProp>
      </ThreadGroup>
      <hashTree>
        ${threadGroup}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;
}

// --- 8. Start Server ---
app.listen(port, () => {
    console.log(`\n🚀 Synapse AI Dashboard server is running.`);
    console.log(`   Access the UI at http://localhost:${port}`);

});
