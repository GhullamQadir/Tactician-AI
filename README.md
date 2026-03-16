# 🏏 Tactician AI 

> **A real-time, voice-enabled AI agent delivering dynamic live cricket insights and expert match analysis.**

## 🌟 About The Project
Tactician AI is an intelligent, voice-interactive companion designed to revolutionize how cricket fans experience live matches. Powered by Google's state-of-the-art Gemini AI, it goes beyond simple score updates by acting as a virtual cricket expert. It analyzes live match situations, provides strategic insights, and communicates with users through a seamless voice interface. 

The application features a modern, highly engaging 3D animated UI with seamless dark and light mode transitions, ensuring an optimal viewing experience for every user.

## ✨ Key Features
* **🧠 AI-Powered Analysis:** Leverages Google Gemini API to analyze match context and provide strategic insights.
* **🗣️ Voice Interaction:** Fully voice-enabled agent that can speak out live scores, commentary, and match summaries.
* **⚡ Real-Time Data:** Fetches live cricket scores and statistics instantly.
* **🎨 Immersive 3D UI:** A visually stunning 3D animated interface that makes data consumption highly interactive.
* **🌗 Dynamic Theming:** Built-in Dark/Light modes for an accessible and personalized user experience.

## 🛠️ Built With (Tech Stack)
* **Frontend:** React (Vite), Tailwind CSS
* **Backend:** Python, FastAPI, Uvicorn
* **AI & NLP:** Google Cloud Generative AI (Gemini), LangChain
* **Voice Integration:** Edge-TTS / gTTS
* **Deployment:** Vercel (Frontend), Render (Backend)

---

## 🚀 Spin-up Instructions (How to Run Locally)

Follow these steps to run the application on your local machine.

### Prerequisites
* Node.js (v16+)
* Python (3.9+)
* API Keys: Google Gemini API Key and RapidAPI Key (for live cricket data).

### 1. Backend Setup (FastAPI & AI Agent)
The backend handles API requests, fetches live data, and processes prompts using Google Gemini.

```bash
# Clone the backend repository (or navigate to the backend directory)
git clone [Insert Your Backend Repo Link Here]
cd [Your Backend Folder Name]

# Install the required Python dependencies
pip install -r requirements.txt

# Create a .env file in the root of the backend folder and add your keys:
# GEMINI_API_KEY=your_gemini_api_key
# RAPIDAPI_KEY=your_rapidapi_key

# Run the backend server
uvicorn main:app --reload

# Navigate to the frontend client directory
cd client

# Install Node modules
npm install

# Create a .env file in the client directory to connect to the backend:
# VITE_API_URL=http://localhost:8000

# Start the Vite development server
npm run dev
