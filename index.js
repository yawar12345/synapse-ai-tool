// index.js - The Complete and Fully Functional Backend Server

// --- 1. Import Dependencies ---
require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { exec } = require('child_process'); // To run shell commands

// --- 2. Initialize Express App ---
const app = express();
const port = 3000;
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- 3. Initialize Gemini AI ---
if (!process.env.GEMINI_API_KEY) {
    console.error("\nFATAL ERROR: GEMINI_API_KEY is not found in .env file.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// --- 4. API Endpoint to Run Tests ---
app.post('/api/run-test', async (req, res) => {
    console.log("Received test execution request...");
    const { steps } = req.body;
    if (!steps) return res.status(400).json({ error: 'Test steps are required.' });

    const resultsLog = [];
    try {
        // --- FIX: A much more detailed and strict prompt for the AI ---
        const prompt = `
        You are an expert Test Automation Engineer. Your task is to convert plain English test steps into a structured JSON array of commands that our script can execute.

        You MUST follow this JSON schema precisely. Do not deviate from the specified "action" names or property keys.

        **JSON Schema:**
        An array of objects, where each object has an "action" key and other keys depending on the action.

        **Available Actions and their required keys:**
        1.  \`"action": "navigate"\`
            -   \`"url"\`: The full URL to navigate to.
        2.  \`"action": "click"\`
            -   \`"selector"\`: The CSS selector of the element to click.
        3.  \`"action": "type"\`
            -   \`"selector"\`: The CSS selector of the input field.
            -   \`"text"\`: The text to type into the field.
        4.  \`"action": "assertVisible"\`
            -   \`"selector"\`: The CSS selector of the element that should be visible.
        5.  \`"action": "wait"\`
            -   \`"duration"\`: The time to wait in milliseconds (e.g., 5000).

        **Important Rules for Selectors:**
        -   Use standard, specific CSS selectors like \`input[name='email']\` or \`#login_button\`.
        -   To find elements by their text content, you MUST use Playwright's text selector format: \`"selector": "text=The exact text to find"\`.
        -   **DO NOT** under any circumstances use non-standard or deprecated selectors like \`:contains()\`. This is invalid and will cause a system failure.

        **Example:**
        User Input: "Go to google.com, type 'Playwright', and check that the 'Google Search' button is visible."
        Your JSON Output:
        [
          {
            "action": "navigate",
            "url": "https://www.google.com"
          },
          {
            "action": "type",
            "selector": "textarea[name='q']",
            "text": "Playwright"
          },
          {
            "action": "assertVisible",
            "selector": "text=Google Search"
          }
        ]

        Now, convert the following user steps. Respond ONLY with the JSON array.

        **User Steps:**
        ${steps}
        `;
        const aiResult = await aiModel.generateContent(prompt);
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

    // Correctly construct the command for `exec`
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
        
        // A non-zero exit code indicates an error.
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
                        const prompt = `
                        You are an expert Test Automation Engineer and a world-class programmer. Your task is to convert a raw recorded Playwright script into a clean, complete, and runnable test script for a specified framework and language.

                        **User's Request:**
                        -   **Framework:** "${framework}"
                        -   **Language:** "${language}"

                        **Instructions:**
                        1.  Analyze the provided raw Playwright actions.
                        2.  Generate a **complete, single-file test script** that is ready to run.
                        3.  The script **MUST** include all necessary imports (e.g., \`const { test, expect } = require('@playwright/test');\`).
                        4.  The script **MUST** wrap the actions inside a standard test block (e.g., \`test('My Recorded Test', async ({ page }) => { ... });\`).
                        5.  Ensure the generated code is well-formatted and follows best practices for the chosen framework and language.
                        6.  If an invalid framework/language combination is requested (like Cypress with Python), default to the framework's standard language (JavaScript for Cypress).
                        7.  **Respond ONLY with the raw code for the test script and nothing else.**

                        **Example for Playwright/JavaScript:**
                        \`\`\`javascript
                        const { test, expect } = require('@playwright/test');

                        test('My Recorded Test', async ({ page }) => {
                          // ... recorded actions go here ...
                        });
                        \`\`\`

                        **Source Raw Playwright Actions:**
                        \`\`\`javascript
                        ${playwrightCode}
                        \`\`\`
                        `;
                        const aiResult = await aiModel.generateContent(prompt);
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

            // Clean up temporary files
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
        const prompt = `You are a Senior QA Engineer. Based on the following feature description, generate a comprehensive list of test steps in plain English. The steps should be clear, concise, and ready to be executed. Each step should be on a new line.

        FEATURE DESCRIPTION:
        "${description}"

        TEST STEPS:`;

        const aiResult = await aiModel.generateContent(prompt);
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
