// index.js - The Complete and Fully Functional Backend Server

// --- 1. Import Dependencies ---
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// --- 2. Initialize Express App ---
const app = express();
const port = 3000;
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- 3. Initialize AI Clients ---
if (!process.env.GEMINI_API_KEY) {
    console.error("\nFATAL ERROR: GEMINI_API_KEY is not found in .env file.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

let groq;
if (process.env.GROQ_API_KEY) {
    groq = new (require('groq-sdk'))({ apiKey: process.env.GROQ_API_KEY });
} else {
    console.warn("\nWARNING: GROQ_API_KEY is not found in .env file. Fallback functionality will be disabled.");
}

// --- Resilient AI Call Helper with Groq Fallback Logic ---
async function generateContentWithFallback(prompt) {
    try {
        console.log("Attempting to generate content with Gemini...");
        const result = await geminiModel.generateContent(prompt);
        return result.response.text();
    } catch (geminiError) {
        console.error("Gemini API Error:", geminiError.message);
        if (groq) {
            console.warn("Gemini failed. Falling back to Groq...");
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: "llama3-8b-8192",
                });
                return chatCompletion.choices[0]?.message?.content || "";
            } catch (groqError) {
                console.error("Groq API Error:", groqError.message);
                throw new Error("Both Gemini and Groq APIs failed.");
            }
        } else {
            throw geminiError;
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
        // --- NEW: Hyper-Robust Prompt for Maximum Edge Case Coverage ---
        const prompt = `
        You are a meticulous and senior Test Automation Engineer. Your sole purpose is to convert unstructured, human-friendly test steps into a perfectly structured JSON array for an automation script. You must be extremely intelligent in interpreting user intent and resilient to ambiguous language.

        **Core Task: Convert the user's steps into a JSON array based on the following strict schema and rules.**

        ---
        ### **JSON Schema & Command Mapping**
        You MUST map the user's intent to one of the following official commands.

        1.  **Navigate to a URL**
            * **User Synonyms:** "navigate", "go to", "open", "visit", "launch"
            * **JSON Object:** \`{ "action": "navigate", "url": "THE_URL" }\`

        2.  **Click an element**
            * **User Synonyms:** "click", "press", "tap", "select", "hit"
            * **JSON Object:** \`{ "action": "click", "selector": "THE_CSS_SELECTOR" }\`

        3.  **Type text into a field**
            * **User Synonyms:** "type", "fill", "enter", "input", "write", "put"
            * **JSON Object:** \`{ "action": "type", "selector": "THE_CSS_SELECTOR", "text": "THE_TEXT" }\`

        4.  **Assert an element is visible**
            * **User Synonyms:** "check", "assert", "verify", "see", "find", "ensure"
            * **JSON Object:** \`{ "action": "assertVisible", "selector": "THE_CSS_SELECTOR_OR_TEXT_SELECTOR" }\`

        ---
        ### **Intelligent Selector Inference Rules**
        This is your most important task. You must intelligently infer the best CSS selector.

        * **If the user gives a direct selector (e.g., "#username"), use it.**
        * **If the user describes an element (e.g., "the login button"), create a robust selector.**
            * For buttons: \`button:has-text("Login")\` or \`[role="button"][name="Login"]\`
            * For inputs: \`input[name="username"]\`, \`[placeholder="Enter username"]\`, or \`#username\`
            * For links: \`a:has-text("Forgot Password")\`
        * **For text assertions, you MUST use Playwright's text selector format:** \`"selector": "text=The exact text to find"\`.
        * **NEVER use invalid or deprecated selectors like \`:contains()\`.**

        ---
        ### **Edge Case Handling**

        * **Multiple Commands on One Line:** Deconstruct them into separate JSON objects in the correct order.
        * **Ambiguous Selectors:** If a user says "click the button", and there might be many, choose the most likely one based on context (e.g., a submit button in a form).
        * **Quotes and Special Characters:** Ensure any quotes within the user's text are properly escaped for the final JSON string.

        ---
        ### **Example Scenarios**

        **Scenario 1 (Complex Single Line):**
        * **User Input:** "go to https://github.com/login then enter username 'test-user' and password 'secret123!' and click the Sign in button"
        * **Your Correct JSON Output:**
            [
              { "action": "navigate", "url": "https://github.com/login" },
              { "action": "type", "selector": "#login_field", "text": "test-user" },
              { "action": "type", "selector": "#password", "text": "secret123!" },
              { "action": "click", "selector": "input[name='commit']" }
            ]

        **Scenario 2 (Vague Assertion):**
        * **User Input:** "verify the error message 'Incorrect username or password.' is visible"
        * **Your Correct JSON Output:**
            [
              { "action": "assertVisible", "selector": "text=Incorrect username or password." }
            ]

        ---
        **Final Instruction:** Convert the following user steps. Respond ONLY with the valid JSON array and nothing else.

        **User Steps:**
        ${steps}
        `;
        const responseText = await generateContentWithFallback(prompt);
        const jsonText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        
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

    // --- FIX: Prepend the command with xvfb-run to create a virtual display ---
    let command = `xvfb-run --auto-servernum npx playwright codegen "${startUrl}" --target javascript -o "${tempCodeFile}"`;
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
                        const responseText = await generateContentWithFallback(prompt);
                        uiScript = responseText.replace(/```[\w\s]*\n/g, '').replace(/```/g, '');
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
        const responseText = await generateContentWithFallback(prompt);
        const generatedSteps = responseText.trim();
        
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
