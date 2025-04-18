const { GoogleGenerativeAI } = require('@google/genai');

// Access your API key as an environment variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  // For text-only input, use the gemini-pro model
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-preview-03-25" });

  const prompt = "Write a short poem about programming in TypeScript";

  const result = await model.generateContent({
    contents: [{ parts: [{ text: prompt }] }],
  });

  const response = result.response;
  console.log(response.text());
}

run().catch(console.error);
