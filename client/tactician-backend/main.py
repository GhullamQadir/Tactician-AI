import base64
import os
import re
import time
import json
import hashlib
import requests
import edge_tts
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.prompts import PromptTemplate
from fallback_data import (
    get_fallback_match_list,
    get_fallback_match_data,
    get_fallback_ai_insight,
    get_fallback_analysis,
    FALLBACK_MATCHES,
)

# Load .env from the same directory as this script
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_env_path)

app = FastAPI()

# ============================================================
# SECURITY: CORS - Configurable allowed origins
# ============================================================
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ============================================================
# API KEYS
# ============================================================
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
RAPID_API_KEY = os.getenv("RAPID_API_KEY", "").strip()
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "").strip() or "fRV3NpXPa1DGVnFs6Dg5"

# ============================================================
# LANGCHAIN AGENT LOGIC
# ============================================================
if GEMINI_API_KEY:
    try:
        llm = ChatGoogleGenerativeAI(model="gemini-1.5-flash", google_api_key=GEMINI_API_KEY)
        prompt_template = PromptTemplate(
            input_variables=["match_data"],
            template="You are a real-time cricket strategy agent. Current match status: {match_data}. Based on this, provide a single, highly analytical sentence advising the bowling team. Be concise and professional."
        )
        chain = prompt_template | llm
        print("[INIT] Langchain Agent initialized")
    except Exception as e:
        chain = None
        print(f"[INIT] Langchain error: {e}")
else:
    chain = None

# ============================================================
# GEMINI CLIENT (with safe import)
# ============================================================
gemini_client = None
try:
    from google import genai
    if GEMINI_API_KEY:
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        print("[INIT] Gemini client initialized")
    else:
        print("[INIT] No GEMINI_API_KEY found — Gemini disabled")
except ImportError:
    print("[INIT] google-genai not installed — Gemini disabled")

CRICBUZZ_HEADERS = {
    "x-rapidapi-key": RAPID_API_KEY,
    "x-rapidapi-host": "cricbuzz-cricket.p.rapidapi.com"
}

# ============================================================
# IN-MEMORY CACHE — Prevents repeated API calls
# Saves quota & makes UX smooth even when APIs are slow
# ============================================================
_cache = {}
CACHE_TTL = {
    "matches": 120,       # Match list: cache 2 minutes
    "match_data": 30,     # Live score data: cache 30 seconds
    "player_search": 3600, # Player search: cache 1 hour
    "player_info": 3600,   # Player info: cache 1 hour
    "player_stats": 3600,  # Player stats: cache 1 hour
    "voice": 600,          # Voice audio: cache 10 minutes
}

def cache_get(key: str):
    if key in _cache:
        entry = _cache[key]
        if time.time() - entry["time"] < entry["ttl"]:
            return entry["data"]
        del _cache[key]
    return None

def cache_set(key: str, data, ttl_type: str = "matches"):
    _cache[key] = {"data": data, "time": time.time(), "ttl": CACHE_TTL.get(ttl_type, 60)}

# ============================================================
# RATE LIMITER — Per-IP request throttling
# ============================================================
_rate_limits = {}
MAX_REQUESTS_PER_MINUTE = 15  # Voice queries per IP per minute

def check_rate_limit(client_ip: str) -> bool:
    now = time.time()
    if client_ip not in _rate_limits:
        _rate_limits[client_ip] = []
    # Clean old entries
    _rate_limits[client_ip] = [t for t in _rate_limits[client_ip] if now - t < 60]
    if len(_rate_limits[client_ip]) >= MAX_REQUESTS_PER_MINUTE:
        return False
    _rate_limits[client_ip].append(now)
    return True

# ============================================================
# API STATUS TRACKER — Tracks which APIs are working
# ============================================================
_api_status = {
    "rapidapi": {"working": True, "last_check": 0, "error": ""},
    "gemini": {"working": True, "last_check": 0, "error": ""},
    "elevenlabs": {"working": True, "last_check": 0, "error": ""},
}

def mark_api_status(api_name: str, working: bool, error: str = ""):
    _api_status[api_name] = {"working": working, "last_check": time.time(), "error": error}

# ============================================================
# GEMINI - Rate limited caller with model fallback  
# ============================================================
last_gemini_call = 0
MIN_GEMINI_INTERVAL = 5

def call_gemini(prompt: str) -> str:
    global last_gemini_call
    if not gemini_client:
        return ""
    
    now = time.time()
    elapsed = now - last_gemini_call
    if elapsed < MIN_GEMINI_INTERVAL:
        time.sleep(MIN_GEMINI_INTERVAL - elapsed)
    
    last_gemini_call = time.time()
    models_to_try = ["gemini-2.0-flash", "gemini-1.5-flash"]
    
    for model_name in models_to_try:
        try:
            resp = gemini_client.models.generate_content(model=model_name, contents=prompt)
            if resp.text:
                mark_api_status("gemini", True)
                return resp.text.strip()
        except Exception as e:
            error_str = str(e)
            print(f"[GEMINI] Error with {model_name}: {error_str[:100]}")
            if "429" in error_str or "RESOURCE_EXHAUSTED" in error_str:
                mark_api_status("gemini", False, "Rate limited")
                time.sleep(2)
                continue
            elif "403" in error_str or "PERMISSION" in error_str:
                mark_api_status("gemini", False, "Invalid API key")
                break
            else:
                mark_api_status("gemini", False, error_str[:50])
                break
    return ""

# ============================================================
# CRICKET DATA FUNCTIONS (RapidAPI / Cricbuzz) — with caching
# ============================================================
def search_player(player_name: str):
    cache_key = f"player_search:{player_name.lower()}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    
    try:
        url = f"https://cricbuzz-cricket.p.rapidapi.com/stats/v1/player/search?plrN={player_name}"
        resp = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            players = data.get("player", [])
            if players:
                result = players[0]
                cache_set(cache_key, result, "player_search")
                mark_api_status("rapidapi", True)
                return result
        elif resp.status_code in (429, 403):
            mark_api_status("rapidapi", False, f"HTTP {resp.status_code}")
    except Exception as e:
        print(f"[RAPIDAPI] Player search error: {e}")
        mark_api_status("rapidapi", False, str(e)[:50])
    return None

def get_player_info(player_id: str):
    cache_key = f"player_info:{player_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    
    try:
        url = f"https://cricbuzz-cricket.p.rapidapi.com/stats/v1/player/{player_id}"
        resp = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            bio = re.sub(r'<[^>]+>', ' ', data.get("bio", "")).strip()[:500]
            result = {
                "name": data.get("name", ""),
                "fullName": data.get("fullName", ""),
                "role": data.get("role", ""),
                "bat": data.get("bat", ""),
                "bowl": data.get("bowl", ""),
                "birthPlace": data.get("birthPlace", ""),
                "height": data.get("height", ""),
                "bio": bio,
                "teamName": data.get("teamName", data.get("intlTeam", ""))
            }
            cache_set(cache_key, result, "player_info")
            return result
    except Exception as e:
        print(f"[RAPIDAPI] Player info error: {e}")
    return None

def get_player_batting_stats(player_id: str):
    cache_key = f"player_bat:{player_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    
    try:
        url = f"https://cricbuzz-cricket.p.rapidapi.com/stats/v1/player/{player_id}/batting"
        resp = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            headers_list = data.get("headers", [])
            stats = {}
            for v in data.get("values", []):
                row_vals = v.get("values", [])
                if row_vals:
                    stat_name = row_vals[0]
                    stat_dict = {}
                    for i, h in enumerate(headers_list):
                        if i < len(row_vals) and h != "ROWHEADER":
                            stat_dict[h] = row_vals[i]
                    stats[stat_name] = stat_dict
            cache_set(cache_key, stats, "player_stats")
            return stats
    except Exception as e:
        print(f"[RAPIDAPI] Batting stats error: {e}")
    return None

def get_player_bowling_stats(player_id: str):
    cache_key = f"player_bowl:{player_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    
    try:
        url = f"https://cricbuzz-cricket.p.rapidapi.com/stats/v1/player/{player_id}/bowling"
        resp = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            headers_list = data.get("headers", [])
            stats = {}
            for v in data.get("values", []):
                row_vals = v.get("values", [])
                if row_vals:
                    stat_name = row_vals[0]
                    stat_dict = {}
                    for i, h in enumerate(headers_list):
                        if i < len(row_vals) and h != "ROWHEADER":
                            stat_dict[h] = row_vals[i]
                    stats[stat_name] = stat_dict
            cache_set(cache_key, stats, "player_stats")
            return stats
    except Exception as e:
        print(f"[RAPIDAPI] Bowling stats error: {e}")
    return None

def fetch_cricket_stats_for_query(query: str):
    query_lower = query.lower()
    stat_keywords = ["stats", "statistics", "record", "runs", "wickets", "centuries", 
                     "average", "strike rate", "innings", "career", "performance",
                     "batting", "bowling", "highest score", "best bowling", "how many",
                     "total runs", "total wickets", "odi", "test", "t20", "ipl",
                     "player", "cricketer", "about"]
    
    if not any(kw in query_lower for kw in stat_keywords):
        return None
    
    stop_words = ["what", "are", "the", "stats", "of", "tell", "me", "about", "give", 
                  "show", "how", "many", "runs", "wickets", "has", "scored", "taken",
                  "player", "cricketer", "is", "was", "does", "do", "his", "her",
                  "batting", "bowling", "career", "statistics", "record", "and", "in",
                  "for", "please", "can", "you", "who", "much", "average", "strike",
                  "rate", "centuries", "total", "international", "odi", "test", "t20", "ipl"]
    
    name_words = []
    for w in query.split():
        clean = re.sub(r'[^a-zA-Z]', '', w)
        if clean.lower() not in stop_words and len(clean) > 1:
            name_words.append(clean)
    
    if not name_words:
        return None
    
    potential_name = " ".join(name_words)
    print(f"[STATS] Searching for player: '{potential_name}'")
    
    player = search_player(potential_name)
    if not player and len(name_words) > 1:
        player = search_player(name_words[-1])
    if not player:
        return None
    
    player_id = player.get("id")
    info = get_player_info(player_id)
    batting = get_player_batting_stats(player_id)
    bowling = get_player_bowling_stats(player_id)
    
    return {
        "player_name": player.get("name", potential_name),
        "player_id": player_id,
        "info": info,
        "batting_stats": batting,
        "bowling_stats": bowling
    }

# ============================================================
# QUERY CLASSIFIER
# ============================================================
def classify_query(query: str, match_context: dict) -> str:
    query_lower = query.lower()
    
    stats_keywords = ["statistics", "career", "centuries", "average", "strike rate",
                      "how many runs has", "total runs in career", "highest score of",
                      "best bowling of"]
    if any(kw in query_lower for kw in stats_keywords):
        return "cricket_stats"
    
    match_keywords = ["match", "score", "batting", "bowling", "wicket", "prediction",
                      "strategy", "tactic", "pitch", "field", "chase", "target", "win",
                      "lose", "over", "partnership", "run rate", "powerplay", "death overs",
                      "what should", "recommend", "analysis", "situation", "current",
                      "how did", "who played", "ended up", "result", "tell me about"]
    if any(kw in query_lower for kw in match_keywords):
        return "match_analysis"
    
    return "general"


class QueryRequest(BaseModel):
    query: str
    match_data: dict = None
    match_id: int = None

# ============================================================
# MATCH DATA — with caching  
# ============================================================
def get_match_data(match_id: int = None):
    cache_key = f"match_data:{match_id or 'default'}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    
    for url_type, url in [("live", "https://cricbuzz-cricket.p.rapidapi.com/matches/v1/live"),
                           ("recent", "https://cricbuzz-cricket.p.rapidapi.com/matches/v1/recent")]:
        try:
            response = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
            if response.status_code == 200:
                data = response.json()
                mark_api_status("rapidapi", True)
                for mType in data.get("typeMatches", []):
                    for series in mType.get("seriesMatches", []):
                        if "seriesAdWrapper" in series:
                            for match in series["seriesAdWrapper"].get("matches", []):
                                m_info = match.get("matchInfo", {})
                                m_score = match.get("matchScore", {})
                                if m_info and m_score:
                                    if match_id is None or m_info.get("matchId") == match_id:
                                        result = extract_match_info(m_info, m_score)
                                        cache_set(cache_key, result, "match_data")
                                        return result
            elif response.status_code in (429, 403):
                mark_api_status("rapidapi", False, f"HTTP {response.status_code}")
        except Exception as e:
            print(f"[RAPIDAPI] Error fetching {url_type} matches: {e}")
            mark_api_status("rapidapi", False, str(e)[:50])
    
    # ——— FALLBACK: Return real pre-existing match data ———
    print("[FALLBACK] RapidAPI unavailable — serving fallback match data")
    return get_fallback_match_data(match_id)

def extract_match_info(m_info, m_score):
    team1 = m_info.get("team1", {}).get("teamSName", "T1")
    team2 = m_info.get("team2", {}).get("teamSName", "T2")
    team1_full = m_info.get("team1", {}).get("teamName", team1)
    team2_full = m_info.get("team2", {}).get("teamName", team2)
    
    score1 = m_score.get("team1Score", {}).get("inngs1", {})
    score2 = m_score.get("team2Score", {}).get("inngs1", {})
    
    match_status = m_info.get("status", "")
    match_format = m_info.get("matchFormat", "")
    series_name = m_info.get("seriesName", "")
    match_desc = m_info.get("matchDesc", "")
    state = m_info.get("state", "")
    
    t_a, t_b = team1, team2
    s_a = f"{score1.get('runs', 0)}/{score1.get('wickets', 0)}" if score1 else "Yet to bat"
    overs_a = score1.get("overs", 0) if score1 else 0
    s_b = f"{score2.get('runs', 0)}/{score2.get('wickets', 0)}" if score2 else "Yet to bat"
    overs_b = score2.get("overs", 0) if score2 else 0
    
    curr_bat_team_id = m_info.get("currBatTeamId")
    if curr_bat_team_id == m_info.get("team2", {}).get("teamId"):
        t_a, t_b = team2, team1
        s_a, s_b = s_b, s_a
        overs_a = overs_b
    
    return {
        "team_a": t_a, "score_a": str(s_a), "team_b": t_b, "score_b": str(s_b),
        "overs": str(overs_a), "current_batter": f"{t_a} Batter",
        "current_bowler": f"{t_b} Bowler", "pitch_turn": "N/A", "win_probability": "N/A",
        "match_status": match_status, "match_format": match_format,
        "series_name": series_name, "match_desc": match_desc, "state": state,
        "team_a_full": team1_full, "team_b_full": team2_full
    }

# ============================================================
# API ENDPOINTS
# ============================================================

@app.get("/api/health")
def health_check():
    """Health check endpoint - shows API status for debugging."""
    return {
        "status": "online",
        "apis": _api_status,
        "cache_size": len(_cache),
        "fallback_matches_available": len(FALLBACK_MATCHES),
        "keys_configured": {
            "gemini": bool(GEMINI_API_KEY),
            "rapidapi": bool(RAPID_API_KEY),
            "elevenlabs": bool(ELEVENLABS_API_KEY),
        }
    }

@app.get("/api/matches")
def get_all_matches():
    cached = cache_get("all_matches")
    if cached is not None:
        return {"matches": cached}
    
    all_matches = []
    api_failed = False
    
    def parse_api_matches(url, match_type_label):
        nonlocal api_failed
        try:
            response = requests.get(url, headers=CRICBUZZ_HEADERS, timeout=10)
            if response.status_code == 200:
                data = response.json()
                mark_api_status("rapidapi", True)
                for mType in data.get("typeMatches", []):
                    for series in mType.get("seriesMatches", []):
                        if "seriesAdWrapper" in series:
                            for match in series["seriesAdWrapper"].get("matches", []):
                                m_info = match.get("matchInfo", {})
                                if m_info:
                                    all_matches.append({
                                        "matchId": m_info.get("matchId"),
                                        "team_a": m_info.get("team1", {}).get("teamSName", "T1"),
                                        "team_b": m_info.get("team2", {}).get("teamSName", "T2"),
                                        "status": m_info.get("status", "Unknown"),
                                        "type": match_type_label,
                                        "series": m_info.get("seriesName", "Unknown Series")
                                    })
            elif response.status_code in (429, 403):
                mark_api_status("rapidapi", False, f"HTTP {response.status_code}")
                api_failed = True
        except Exception as e:
            print(f"[RAPIDAPI] Error fetching {match_type_label} matches: {e}")
            mark_api_status("rapidapi", False, str(e)[:50])
            api_failed = True

    parse_api_matches("https://cricbuzz-cricket.p.rapidapi.com/matches/v1/live", "Live")
    parse_api_matches("https://cricbuzz-cricket.p.rapidapi.com/matches/v1/recent", "Recent")
    
    if all_matches:
        cache_set("all_matches", all_matches, "matches")
        return {"matches": all_matches, "source": "live"}
    
    # ——— FALLBACK: Serve real pre-existing match data ———
    if not all_matches:
        print("[FALLBACK] RapidAPI returned no matches — serving fallback match list")
        fallback = get_fallback_match_list()
        return {"matches": fallback, "source": "fallback"}

@app.get("/api/agent-data")
def get_agent_data(match_id: int = None):
    match_data = get_match_data(match_id)
    
    if chain:
        try:
            response = chain.invoke({"match_data": str(match_data)})
            ai_insight = response.content.strip()
        except Exception as e:
            print(f"Agent Error: {e}")
            ai_insight = "Agent system re-calibrating..."
    else:
        ai_insight = "Agent system re-calibrating (Langchain not initialized)..."

    return {"match_data": match_data, "ai_insight": ai_insight}

# ============================================================
# SMART AGENT QUERY — Routes between RapidAPI & Gemini
# 1. Match Analysis   -> RapidAPI (live data) + Gemini (AI insight)
# 2. Cricket Stats    -> RapidAPI ONLY
# 3. General Question -> Gemini ONLY
# ============================================================
@app.post("/api/agent-query")
def agent_query(req: QueryRequest, request: Request):
    # Rate limit check
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        return {"answer": "You're asking too many questions too quickly! Please wait a moment and try again."}
    
    context = req.match_data or get_match_data(req.match_id)
    query = req.query
    query_type = classify_query(query, context)
    print(f"[ROUTING] Query: '{query}' -> Type: {query_type} | IP: {client_ip}")
    
    # PATH 1: CRICKET STATS — RapidAPI ONLY
    if query_type == "cricket_stats":
        stats_data = fetch_cricket_stats_for_query(query)
        
        if stats_data and stats_data.get("info"):
            info = stats_data["info"]
            batting = stats_data.get("batting_stats", {})
            bowling = stats_data.get("bowling_stats", {})
            
            name = info.get("name", "Unknown Player")
            role = info.get("role", "Cricketer")
            team = info.get("teamName", "")
            
            parts = [f"{name} is a {role} from {team}."]
            if info.get("bat"):
                parts.append(f"Batting style: {info['bat']}.")
            if info.get("bowl") and info["bowl"] != "N/A":
                parts.append(f"Bowling style: {info['bowl']}.")
            if info.get("birthPlace"):
                parts.append(f"Born in {info['birthPlace']}.")
            
            if batting:
                for key, label in [("Matches", "Matches played"), ("Runs", "Total runs"),
                                   ("Average", "Batting average"), ("Highest", "Highest score"),
                                   ("100s", "Centuries"), ("50s", "Half-centuries"), ("SR", "Strike rate")]:
                    if key in batting:
                        d = batting[key]
                        parts.append(f"{label}: Test {d.get('Test', 'N/A')}, ODI {d.get('ODI', 'N/A')}, T20 {d.get('T20', 'N/A')}.")
            
            if bowling and "Wickets" in bowling:
                w = bowling["Wickets"]
                if w.get("Test", "0") != "0" or w.get("ODI", "0") != "0":
                    parts.append(f"Wickets: Test {w.get('Test', '0')}, ODI {w.get('ODI', '0')}, T20 {w.get('T20', '0')}.")
            
            return {"answer": " ".join(parts)}
        else:
            # RapidAPI unavailable — extract player name for friendly message
            name_words_out = [re.sub(r'[^a-zA-Z]', '', w) for w in query.split()
                              if re.sub(r'[^a-zA-Z]', '', w).lower() not in 
                              ["what","are","the","stats","of","tell","me","about","give","show","how",
                               "many","please","can","you","his","her","is","was","batting","bowling",
                               "career","statistics","record","runs","wickets","centuries","average",
                               "player","cricketer"] and len(re.sub(r'[^a-zA-Z]', '', w)) > 1]
            name_guess = " ".join(name_words_out) if name_words_out else "the player"
            return {"answer": f"I'd love to give you stats on {name_guess}! My Cricbuzz data API has reached its limit. Try asking about the current match analysis instead!"}
    
    # PATH 2: MATCH ANALYSIS — RapidAPI data + Gemini AI
    elif query_type == "match_analysis":
        state = context.get("state", "")
        status = context.get("match_status", "")
        team_a = context.get("team_a", "")
        team_b = context.get("team_b", "")
        score_a = context.get("score_a", "")
        score_b = context.get("score_b", "")
        series = context.get("series_name", "")
        match_format = context.get("match_format", "")
        
        if state == "Complete":
            system_ctx = (f"You are Tactician AI, a cricket analyst. COMPLETED match: {team_a} {score_a} vs {team_b} {score_b}. "
                          f"Result: {status}. Series: {series}. Format: {match_format}. Give post-match analysis.")
        else:
            system_ctx = (f"You are Tactician AI, a live cricket tactician. LIVE: {team_a} {score_a} vs {team_b} {score_b}. "
                          f"Status: {status}. Series: {series}. Format: {match_format}. Give tactical predictions.")
        
        if context.get("is_fallback") and req.match_id:
            raw_fallback_data = get_fallback_analysis(req.match_id, query)
            system_ctx += f" The match details are: {raw_fallback_data}. Base your analysis completely on these facts."
            
        prompt = f"{system_ctx}\n\nUser asked: '{query}'\n\nGive a detailed but concise answer (2-4 sentences)."
        answer = call_gemini(prompt)
        
        if not answer:
            # Check if this is a fallback match — give rich analysis from stored data
            if context.get("is_fallback") and req.match_id:
                answer = get_fallback_analysis(req.match_id, query)
            elif state == "Complete":
                answer = f"Match completed: {team_a} scored {score_a}, {team_b} scored {score_b}. {status}. This was part of {series} ({match_format})."
            else:
                answer = f"Live update: {team_a} is at {score_a} against {team_b} ({score_b}). {status}."

        
        return {"answer": answer}
    
    # PATH 3: GENERAL QUESTION — Gemini ONLY (unless fallback)
    # PATH 3: GENERAL QUESTION — Gemini ONLY
    else:
        system_ctx = "You are Tactician AI, a friendly voice assistant specializing in cricket."
        if context.get("is_fallback") and req.match_id:
            raw_fallback_data = get_fallback_analysis(req.match_id, query)
            system_ctx += f" The user's currently selected match is: {raw_fallback_data}."
            
        prompt = (f"{system_ctx}\n\nUser asked: '{query}'\n\nGive a helpful, concise answer (2-4 sentences).")
        answer = call_gemini(prompt)
        if not answer:
            if context.get("is_fallback") and req.match_id:
                answer = get_fallback_analysis(req.match_id, query)
            else:
                answer = "I'm Tactician AI, your cricket strategy assistant. I can help with match analysis, player stats, and predictions. Ask me about the current match!"
        return {"answer": answer}

# ============================================================
# VOICE — Microsoft Edge Neural TTS (100% FREE, NO API KEY)
# ============================================================
@app.get("/api/get-voice")
async def get_voice(text: str):
    # Cache voice responses
    text_hash = hashlib.md5(text.encode()).hexdigest()
    cache_key = f"voice:{text_hash}"
    cached = cache_get(cache_key)
    if cached is not None:
        return {"audio": cached}
    
    try:
        # "en-US-ChristopherNeural" or "en-GB-RyanNeural" are incredible male voices
        communicate = edge_tts.Communicate(text, "en-US-ChristopherNeural")
        audio_data = b""
        
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
                
        audio_base64 = base64.b64encode(audio_data).decode('utf-8')
        cache_set(cache_key, audio_base64, "voice")
        mark_api_status("elevenlabs", True) # reusing the status flag visually for the frontend
        return {"audio": audio_base64}
        
    except Exception as e:
        error_msg = str(e)
        print(f"[EDGE TTS] Error: {error_msg}")
        mark_api_status("elevenlabs", False, error_msg[:50])
        return {"error": error_msg}

@app.get("/")
def read_root():
    return {"message": "Welcome to Tactician AI API", "version": "2.0"}

if __name__ == "__main__":
    import uvicorn
    print("[STARTUP] Tactician AI Backend v2.0")
    print(f"[STARTUP] APIs configured: Gemini={'Yes' if GEMINI_API_KEY else 'No'}, RapidAPI={'Yes' if RAPID_API_KEY else 'No'}, ElevenLabs={'Yes' if ELEVENLABS_API_KEY else 'No'}")
    print(f"[STARTUP] Allowed Origins: {ALLOWED_ORIGINS}")
    uvicorn.run(app, host="0.0.0.0", port=8000)
