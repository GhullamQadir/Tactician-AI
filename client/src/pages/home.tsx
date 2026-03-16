import React, { useState, useEffect, useRef } from "react";
import { ContainerScroll } from "@/components/ui/container-scroll-animation";
import { motion } from "framer-motion";
import { Activity, Mic, Radio, Zap, AlertTriangle, ShieldAlert, Sun, Moon, Volume2, VolumeX } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ============================================================
// API URL — Change this when deploying to production
// In dev: http://localhost:8000
// In prod: https://your-backend-url.com
// ============================================================
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

interface AgentData {
  match_data: {
    team_a: string;
    score_a: string;
    team_b: string;
    score_b: string;
    overs: string;
    current_batter: string;
    current_bowler: string;
    pitch_turn: string;
    win_probability: string;
    match_status: string;
  };
  ai_insight: string;
}

export default function AgentDashboard() {
  const [data, setData] = useState<AgentData | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'listening' | 'processing' | 'speaking'>('idle');
  const [userTranscript, setUserTranscript] = useState<string>('');
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const [apiHealth, setApiHealth] = useState<string>('checking');
  
  const [matches, setMatches] = useState<any[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  const [dataSource, setDataSource] = useState<'live' | 'fallback' | 'unknown'>('unknown');
  const { toast } = useToast();

  // Check backend health on load
  const checkHealth = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        setApiHealth('online');
      } else {
        setApiHealth('degraded');
      }
    } catch {
      setApiHealth('offline');
    }
  };

  // Fetch match list
  const fetchMatches = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/matches`, { signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      const matchList = result.matches || [];
      const source = result.source || 'live';
      setDataSource(source);
      setMatches(matchList);
      if (matchList.length > 0 && !selectedMatchId) {
        setSelectedMatchId(matchList[0].matchId);
      }
      if (matchList.length === 0) {
        setLoading(false);
        setData({
          match_data: {
            team_a: "No Matches", score_a: "-", team_b: "Available", score_b: "-",
            overs: "-", current_batter: "N/A", current_bowler: "N/A",
            pitch_turn: "N/A", win_probability: "N/A",
            match_status: "No live or recent matches found."
          },
          ai_insight: "No match data available right now. You can still ask me general questions using the mic!"
        });
      }
    } catch (err) {
      console.error("Failed to fetch matches:", err);
      setApiHealth('offline');
      setLoading(false);
      setData({
        match_data: {
          team_a: "Backend", score_a: "-", team_b: "Offline", score_b: "-",
          overs: "-", current_batter: "N/A", current_bowler: "N/A",
          pitch_turn: "N/A", win_probability: "N/A",
          match_status: "Cannot connect to backend server."
        },
        ai_insight: "Backend server is not responding. Make sure the Python backend is running on port 8000."
      });
    }
  };

  // Fetch match score data (no Gemini call)
  const fetchData = async () => {
    try {
      let url = `${API_BASE}/api/agent-data`;
      if (selectedMatchId) {
        url += `?match_id=${selectedMatchId}`;
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      
      setData(prev => {
        if (prev && userTranscript) {
          return { ...prev, match_data: result.match_data };
        }
        return result;
      });
      setError(null);
    } catch (err) {
      console.error("Connection to Backend failed:", err);
      setError('Failed to connect to backend');
      setData(prev => prev || {
        match_data: {
          team_a: "Offline", score_a: "-", team_b: "-", score_b: "-",
          overs: "-", current_batter: "N/A", current_bowler: "N/A",
          pitch_turn: "N/A", win_probability: "N/A",
          match_status: "No active match data found."
        },
        ai_insight: "Connection failed. The backend may be offline."
      });
    } finally {
      if(loading) setLoading(false);
    }
  };

  // Stop all audio playback immediately
  const stopAllAudio = () => {
    window.speechSynthesis.cancel();
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
      activeAudioRef.current.currentTime = 0;
      activeAudioRef.current = null;
    }
    if (agentStatus === 'speaking') {
      setAgentStatus('idle');
    }
  };

  // Browser speech fallback (always works, no API needed)
  const speakText = (text: string) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.onend = () => setAgentStatus('idle');
    utterance.onerror = () => setAgentStatus('idle');
    window.speechSynthesis.speak(utterance);
  };

  // Try ElevenLabs -> fallback to browser speech
  const playVoice = async (text: string) => {
    setAgentStatus('speaking');
    try {
      const vResponse = await fetch(`${API_BASE}/api/get-voice?text=${encodeURIComponent(text)}`, 
        { signal: AbortSignal.timeout(15000) });
      const vData = await vResponse.json();
      if (vData.audio) {
        window.speechSynthesis.cancel();
        const audio = new Audio(`data:audio/mp3;base64,${vData.audio}`);
        activeAudioRef.current = audio;
        audio.onended = () => { activeAudioRef.current = null; setAgentStatus('idle'); };
        audio.onerror = () => { activeAudioRef.current = null; speakText(text); };
        audio.play().catch(() => { activeAudioRef.current = null; speakText(text); });
      } else {
        if (vData.error && (vData.error.includes("402") || vData.error.includes("Payment") || vData.error.includes("Invalid API key"))) {
          toast({
            title: "ElevenLabs API Notice",
            description: vData.error + ". Falling back to browser voice...",
            variant: "destructive",
          });
        }
        speakText(text);
      }
    } catch {
      speakText(text);
    }
  };

  const handleMicClick = () => {
    if (agentStatus === 'processing' || agentStatus === 'speaking') return;
    
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert("Speech recognition is not supported in this browser. Please use Chrome or Edge.");
      return;
    }
    
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setAgentStatus('listening');
      setUserTranscript('');
    };

    recognition.onresult = async (event: any) => {
      const transcript = event.results[0][0].transcript;
      setUserTranscript(transcript);
      setIsListening(false);
      setAgentStatus('processing');
      
      try {
        const resp = await fetch(`${API_BASE}/api/agent-query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: transcript, match_data: data?.match_data, match_id: selectedMatchId }),
          signal: AbortSignal.timeout(30000)
        });
        const resData = await resp.json();
        const answer = resData.answer;
        
        setData(prev => prev ? { ...prev, ai_insight: answer } : null);
        
        if (!isMuted) {
          await playVoice(answer);
        } else {
          setAgentStatus('idle');
        }
      } catch (e) {
        console.error("Error querying agent:", e);
        const fallback = `I can see ${data?.match_data?.team_a || 'the team'} is at ${data?.match_data?.score_a || 'a competitive score'} against ${data?.match_data?.team_b || 'the opponent'}. ${data?.match_data?.match_status || ''}. Let me know what specific analysis you need.`;
        setData(prev => prev ? { ...prev, ai_insight: fallback } : null);
        if (!isMuted) {
          await playVoice(fallback);
        } else {
          setAgentStatus('idle');
        }
      }
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      setAgentStatus('idle');
      if (event.error === 'not-allowed') {
        setData(prev => prev ? { ...prev, ai_insight: 'Microphone access denied. Please allow microphone permission in your browser settings and try again.' } : null);
      }
    };
    
    recognition.onend = () => {
      setIsListening(false);
    };
    
    recognition.start();
  };

  // Initial load
  useEffect(() => {
    checkHealth();
    fetchMatches();
  }, []);

  // Auto-update match data every 30 seconds
  useEffect(() => {
    if (selectedMatchId) {
      setUserTranscript('');
      fetchData(); 
      const interval = setInterval(fetchData, 30000); // 30 seconds = fewer API calls
      return () => {
        clearInterval(interval);
        window.speechSynthesis.cancel();
      };
    }
  }, [selectedMatchId]);

  // Theme sync
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  const batterInfo = data?.match_data?.current_batter || "Searching...";
  const bowlerInfo = data?.match_data?.current_bowler || "Loading...";

  // API health indicator color
  const healthColor = apiHealth === 'online' ? 'bg-emerald-500' : apiHealth === 'degraded' ? 'bg-yellow-500' : apiHealth === 'offline' ? 'bg-red-500' : 'bg-gray-500';

  return (
    <div className={`flex flex-col transition-colors duration-500 overflow-hidden pb-[100px] pt-[50px] min-h-screen font-sans ${isDark ? 'bg-[#050505] text-white' : 'bg-gray-100 text-slate-900'}`}>
      
      {/* Top Agent Status Bar */}
      <nav className={`w-full px-8 py-4 flex justify-between items-center border-b fixed top-0 z-50 transition-all duration-500 ${
        isDark 
          ? 'backdrop-blur-xl bg-black/40 border-white/10' 
          : 'backdrop-blur-xl bg-white/40 border-black/10'
      }`}>
        <div className="flex items-center gap-3">
          <div className="relative flex h-4 w-4">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${healthColor}`}></span>
            <span className={`relative inline-flex rounded-full h-4 w-4 ${healthColor}`}></span>
          </div>
          <span className="font-bold text-lg tracking-wider">
            TACTICIAN.AI 
            <span className={`font-mono text-sm ml-2 ${
              apiHealth === 'online' ? (isDark ? 'text-emerald-500' : 'text-emerald-600') :
              apiHealth === 'degraded' ? 'text-yellow-500' : 'text-red-500'
            }`}>
              {apiHealth === 'online' ? 'CORE_ONLINE' : apiHealth === 'degraded' ? 'DEGRADED' : apiHealth === 'offline' ? 'OFFLINE' : 'CHECKING...'}
            </span>
          </span>
        </div>
        
        <div className="flex items-center gap-8">
          <div className={`flex gap-6 font-mono text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <span className="flex items-center gap-2">
              <Radio size={14} className={isDark ? 'text-emerald-500' : 'text-emerald-600'}/> 
              DATA STREAM: {apiHealth === 'online' ? (dataSource === 'fallback' ? 'CACHED' : 'ACTIVE') : 'LIMITED'}
            </span>
            <span className="flex items-center gap-2">
              <Zap size={14} className="text-yellow-500"/> 
              MATCHES: {matches.length}
            </span>
          </div>

          <button 
            onClick={() => setIsDark(!isDark)}
            className={`p-2 rounded-full transition-all hover:scale-110 active:scale-95 ${
              isDark ? 'bg-white/10 text-yellow-400' : 'bg-black/10 text-indigo-600'
            }`}
            aria-label="Toggle Theme"
          >
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button 
            onClick={() => {
              const newMuted = !isMuted;
              setIsMuted(newMuted);
              if (newMuted) {
                stopAllAudio();
              }
            }} 
            className={`p-2 rounded-full border transition-all hover:scale-110 active:scale-95 ${
              isMuted 
                ? 'border-red-500 bg-red-500/10 text-red-500' 
                : 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
            }`}
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </button>
        </div>
      </nav>

      {/* Main 3D Container Area */}
      <ContainerScroll
        titleComponent={
          <div className="mb-8 mt-20">
            <h1 className={`text-4xl md:text-5xl font-semibold text-center transition-colors duration-500 ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Live Match <br />
              <span className={`text-5xl md:text-[6rem] font-bold mt-1 leading-none text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-cyan-500 to-blue-500 ${isDark ? 'drop-shadow-[0_0_15px_rgba(16,185,129,0.5)]' : ''}`}>
                Command Center
              </span>
            </h1>
          </div>
        }
      >
        <div className={`relative h-full w-full rounded-2xl p-6 flex flex-col gap-6 overflow-hidden transition-colors duration-500 ${isDark ? 'bg-[#0a0a0a]' : 'bg-white/80'}`}>
          <div className={`absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] ${!isDark ? 'opacity-50' : ''}`}></div>

          <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-6 h-full">
            
            {/* Left Column: Live Scorecard */}
            <motion.div 
              initial={{ opacity: 0, x: -20 }} 
              animate={{ opacity: 1, x: 0 }} 
              transition={{ duration: 0.5 }}
              className={`col-span-1 md:col-span-2 rounded-xl p-6 flex flex-col justify-between transition-all duration-500 ${
                isDark 
                  ? 'backdrop-blur-2xl bg-white/5 border border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.3)]' 
                  : 'backdrop-blur-2xl bg-white/60 border border-white/40 shadow-[0_4px_30px_rgba(0,0,0,0.1)]'
              }`}
            >
              <div className={`flex flex-col md:flex-row justify-between items-start md:items-center border-b pb-4 gap-4 ${isDark ? 'border-zinc-800' : 'border-gray-200'}`}>
                <div className="flex items-center gap-4">
                  {dataSource === 'fallback' ? (
                    <span className={`font-mono font-bold flex items-center gap-2 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                      <span className="w-2 h-2 rounded-full bg-amber-400"></span> RECENT
                    </span>
                  ) : (
                    <span className="text-red-500 font-mono font-bold animate-pulse flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500"></span> LIVE
                    </span>
                  )}
                  
                  <select 
                    className={`text-sm px-3 py-1 rounded-md border font-mono transition-all outline-none max-w-[200px] truncate ${
                      isDark ? 'bg-zinc-900 border-zinc-700 text-emerald-400' : 'bg-gray-50 border-gray-300 text-emerald-700'
                    }`}
                    value={selectedMatchId || ""}
                    onChange={(e) => {
                      setSelectedMatchId(Number(e.target.value));
                      setLoading(true);
                      setData(null);
                    }}
                  >
                    {matches.length === 0 && <option value="">No Matches Available</option>}
                    {matches.map((m) => (
                      <option key={m.matchId} value={m.matchId}>
                        [{m.type}] {m.team_a} vs {m.team_b} 
                      </option>
                    ))}
                  </select>
                </div>

                <span className={`font-mono text-sm max-w-[50%] text-right truncate ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {data?.match_data?.match_status || "Fetching Status..."}
                </span>
              </div>
              
              <div className="flex justify-between items-center my-6">
                <div className="text-center w-40">
                  <h2 className={`text-4xl font-bold transition-colors ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    {data?.match_data?.team_a || "TBA"}
                  </h2>
                  <p className={`text-2xl font-mono mt-2 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    {data?.match_data?.score_a || "-"}
                  </p>
                  <p className={`text-sm mt-1 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Overs: {data?.match_data?.overs || "0.0"}</p>
                </div>
                <div className={`text-3xl font-bold ${isDark ? 'text-zinc-700' : 'text-gray-300'}`}>VS</div>
                <div className="text-center w-40">
                  <h2 className={`text-4xl font-bold transition-colors ${isDark ? 'text-gray-400' : 'text-gray-400'}`}>
                    {data?.match_data?.team_b || "TBA"}
                  </h2>
                  <p className={`text-2xl font-mono mt-2 ${isDark ? 'text-gray-600' : 'text-gray-500'}`}>
                    {data?.match_data?.score_b || "-"}
                  </p>
                </div>
              </div>

              <div className={`p-4 rounded-lg border transition-colors ${isDark ? 'bg-zinc-950 border-zinc-800' : 'bg-gray-50/50 border-gray-200'}`}>
                <div className="flex justify-between">
                  <div>
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Current Batter</p>
                    <p className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{batterInfo}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>Current Bowler</p>
                    <p className={`font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>{bowlerInfo}</p>
                  </div>
                </div>
              </div>
            </motion.div>

            {/* Right Column: AI Agent Interface */}
            <motion.div 
              initial={{ opacity: 0, x: 20 }} 
              animate={{ opacity: 1, x: 0 }} 
              transition={{ duration: 0.6 }}
              className={`col-span-1 rounded-xl p-6 flex flex-col justify-between relative overflow-hidden transition-all duration-500 ${
                isDark 
                  ? 'backdrop-blur-2xl bg-emerald-950/20 border border-emerald-500/30 shadow-[0_4px_30px_rgba(0,0,0,0.3)]' 
                  : 'backdrop-blur-2xl bg-white/60 border border-emerald-200 shadow-[0_4px_30px_rgba(0,0,0,0.1)]'
              }`}
            >
               <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 rounded-full blur-3xl ${isDark ? 'bg-emerald-500/20' : 'bg-emerald-400/10'}`}></div>

              <div className="relative z-10">
                <div className="flex items-center gap-3 mb-6">
                  <button 
                    onClick={handleMicClick} 
                    disabled={agentStatus === 'processing'}
                    className={`w-12 h-12 rounded-full flex items-center justify-center border-2 transition-all cursor-pointer ${
                      agentStatus === 'listening' ? 'bg-red-500/20 border-red-500 animate-pulse scale-110' : 
                      agentStatus === 'processing' ? 'bg-yellow-500/20 border-yellow-500 animate-pulse' : 
                      agentStatus === 'speaking' ? 'bg-cyan-500/20 border-cyan-500 animate-pulse' :  
                      isDark ? 'bg-black border-emerald-500 hover:scale-110 hover:bg-emerald-500/10' : 'bg-white border-emerald-400 shadow-sm hover:scale-110'
                    }`}
                    title="Click to speak with the Agent"
                  >
                    <Mic className={`${
                      agentStatus === 'listening' ? 'text-red-500' : 
                      agentStatus === 'processing' ? 'text-yellow-500' : 
                      agentStatus === 'speaking' ? 'text-cyan-400' :
                      isDark ? 'text-emerald-400' : 'text-emerald-600'
                    } w-6 h-6`} />
                  </button>
                  <div>
                    <h3 className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Tactician Voice Agent</h3>
                    <p className={`text-xs font-mono ${
                      agentStatus === 'listening' ? 'text-red-400' :
                      agentStatus === 'processing' ? 'text-yellow-400' :
                      agentStatus === 'speaking' ? 'text-cyan-400' :
                      isDark ? 'text-emerald-500/70' : 'text-emerald-600'
                    }`}>
                      {agentStatus === 'listening' ? '🎙️ Listening... Speak now!' : 
                       agentStatus === 'processing' ? '🧠 Analyzing your question...' : 
                       agentStatus === 'speaking' ? '🔊 Speaking...' :
                       loading ? '⏳ Connecting...' : '✅ Ready — Click mic to speak'}
                    </p>
                  </div>
                </div>

                {/* User Transcript Display */}
                {userTranscript && (
                  <div className={`mb-4 p-3 rounded-lg border text-xs font-mono ${
                    isDark ? 'bg-zinc-900/80 border-zinc-700 text-gray-400' : 'bg-gray-50 border-gray-200 text-gray-600'
                  }`}>
                    <span className={isDark ? 'text-cyan-400' : 'text-cyan-600'}>You said:</span> "{userTranscript}"
                  </div>
                )}

                {/* Animated Voice Visualizer Bars */}
                <div className="flex gap-1 items-end h-16 mb-6 justify-center">
                  {[...Array(12)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ height: 
                        agentStatus === 'listening' ? ["30%", "90%", "50%", "100%", "40%"] :
                        agentStatus === 'speaking' ? ["20%", "80%", "60%", "95%", "35%"] :
                        agentStatus === 'processing' ? ["10%", "30%", "10%", "30%", "10%"] :
                        ["15%", "25%", "15%", "25%", "15%"]
                      }}
                      transition={{ repeat: Infinity, duration: 
                        agentStatus === 'listening' ? 0.8 : 
                        agentStatus === 'speaking' ? 1.2 : 
                        agentStatus === 'processing' ? 0.6 : 3, 
                        ease: "easeInOut", delay: i * 0.08 
                      }}
                      className={`w-2 rounded-t-sm ${
                        agentStatus === 'listening' ? 'bg-red-500' :
                        agentStatus === 'speaking' ? 'bg-cyan-500' :
                        agentStatus === 'processing' ? 'bg-yellow-500' :
                        isDark ? 'bg-emerald-500/60' : 'bg-emerald-500/60'
                      }`}
                    ></motion.div>
                  ))}
                </div>

                <div className={`p-4 rounded-lg border text-sm leading-relaxed font-mono transition-all duration-500 max-h-[200px] overflow-y-auto ${
                  isDark 
                    ? 'bg-black/60 border-emerald-500/20 text-gray-300' 
                    : 'bg-white/80 border-emerald-200 text-slate-700 shadow-sm'
                }`}>
                  {agentStatus === 'processing' ? (
                    <>
                      {'>'} Processing your question...<br/>
                      <span className={`mt-2 block animate-pulse ${isDark ? 'text-yellow-400' : 'text-yellow-600 font-bold'}`}>
                        🧠 Analyzing match data with AI...
                      </span>
                    </>
                  ) : loading && !data ? (
                    <>
                      {'>'} Connecting to AI backend...<br/>
                      <span className={`mt-2 block animate-pulse ${isDark ? 'text-yellow-400' : 'text-yellow-600 font-bold'}`}>
                        Establishing secure channel...
                      </span>
                    </>
                  ) : error && !data ? (
                    <>
                      {'>'} {error}<br/>
                      <span className={`mt-2 block ${isDark ? 'text-red-400' : 'text-red-600 font-bold'}`}>
                        Running in offline mode
                      </span>
                    </>
                  ) : (
                    <>
                      {'>'} {data?.ai_insight || "Select a match and click the mic to start talking!"}
                    </>
                  )}
                </div>
              </div>
            </motion.div>

          </div>
        </div>
      </ContainerScroll>

      {/* Floating Mic Button - Always visible at bottom right */}
      <motion.button
        onClick={handleMicClick}
        disabled={agentStatus === 'processing'}
        className={`fixed bottom-8 right-8 z-50 w-16 h-16 rounded-full flex items-center justify-center shadow-2xl transition-all ${
          agentStatus === 'listening' ? 'bg-red-500 shadow-red-500/50 scale-110' :
          agentStatus === 'processing' ? 'bg-yellow-500 shadow-yellow-500/50' :
          agentStatus === 'speaking' ? 'bg-cyan-500 shadow-cyan-500/50' :
          'bg-emerald-500 shadow-emerald-500/50 hover:scale-110 hover:shadow-emerald-500/70'
        }`}
        whileHover={{ scale: agentStatus === 'processing' ? 1 : 1.1 }}
        whileTap={{ scale: 0.95 }}
        title="Click to speak with Tactician AI"
      >
        <Mic className="text-white w-7 h-7" />
        {(agentStatus === 'listening' || agentStatus === 'speaking') && (
          <span className="absolute inset-0 rounded-full animate-ping opacity-30 bg-current"></span>
        )}
      </motion.button>
    </div>
  );
}
