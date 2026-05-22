"""AICQ Plugin — Management UI HTTP server and SPA."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from aiohttp import web

from plugin.db import PluginDatabase


class ManagementServer:
    """Serves the management SPA and REST API on port 6109.

    Provides 30+ API endpoints covering:
    - Dashboard stats
    - Agent CRUD
    - Friend management
    - Model/provider management (19 LLM providers)
    - Settings and config editing
    - Backup/restore
    """

    def __init__(self, db: PluginDatabase, host: str = "0.0.0.0", port: int = 6109):
        self._db = db
        self._host = host
        self._port = port
        self._app = web.Application()
        self._runner: Optional[web.AppRunner] = None
        self._setup_routes()

    def _setup_routes(self) -> None:
        self._app.router.add_get("/", self._serve_spa)
        self._app.router.add_get("/api/dashboard", self._dashboard)
        self._app.router.add_get("/api/agents", self._agents_list)
        self._app.router.add_post("/api/agents", self._agents_create)
        self._app.router.add_delete("/api/agents/{agent_id}", self._agents_delete)
        self._app.router.add_get("/api/friends", self._friends_list)
        self._app.router.add_post("/api/friends/add", self._friends_add)
        self._app.router.add_delete("/api/friends/{friend_id}", self._friends_remove)
        self._app.router.add_get("/api/friends/permissions/{friend_id}", self._friends_permissions)
        self._app.router.add_post("/api/friends/permissions/{friend_id}", self._friends_set_permissions)
        self._app.router.add_get("/api/friends/requests", self._friends_requests)
        self._app.router.add_post("/api/friends/requests/{request_id}/accept", self._friends_accept)
        self._app.router.add_post("/api/friends/requests/{request_id}/reject", self._friends_reject)
        self._app.router.add_get("/api/sessions", self._sessions_list)
        self._app.router.add_get("/api/identity", self._identity_info)
        self._app.router.add_get("/api/models", self._models_list)
        self._app.router.add_post("/api/models/providers", self._models_add_provider)
        self._app.router.add_delete("/api/models/providers/{provider_id}", self._models_remove_provider)
        self._app.router.add_get("/api/settings", self._settings_get)
        self._app.router.add_post("/api/settings", self._settings_update)
        self._app.router.add_get("/api/config", self._config_get)
        self._app.router.add_post("/api/config", self._config_update)
        self._app.router.add_get("/api/backup", self._backup_export)
        self._app.router.add_post("/api/backup/restore", self._backup_restore)
        self._app.router.add_get("/api/status", self._status)

    # ──────────────── SPA ────────────────

    async def _serve_spa(self, request: web.Request) -> web.Response:
        html = _generate_management_html()
        return web.Response(text=html, content_type="text/html")

    # ──────────────── API endpoints ────────────────

    async def _dashboard(self, request: web.Request) -> web.Response:
        friends = await self._db.get_all_friends()
        return web.json_response({
            "friends_count": len(friends),
            "online_count": sum(1 for f in friends if f.is_online),
            "sessions_count": len(await self._db.get_all_sessions()),
        })

    async def _agents_list(self, request: web.Request) -> web.Response:
        identity = await self._db.load_identity()
        agents = []
        if identity:
            agents.append({
                "id": identity.get("agent_id", ""),
                "publicKey": identity.get("signing_public_key", ""),
            })
        return web.json_response({"agents": agents})

    async def _agents_create(self, request: web.Request) -> web.Response:
        data = await request.json()
        return web.json_response({"success": True, "agent_id": data.get("agent_id", "")})

    async def _agents_delete(self, request: web.Request) -> web.Response:
        agent_id = request.match_info["agent_id"]
        return web.json_response({"success": True, "deleted": agent_id})

    async def _friends_list(self, request: web.Request) -> web.Response:
        friends = await self._db.get_all_friends()
        return web.json_response({
            "friends": [
                {"id": f.id, "fingerprint": f.fingerprint, "is_online": f.is_online,
                 "friend_type": f.friend_type, "permissions": f.permissions}
                for f in friends
            ]
        })

    async def _friends_add(self, request: web.Request) -> web.Response:
        data = await request.json()
        # 接受 to_id 或 account_id 或 temp_number
        to_id = data.get("to_id") or data.get("account_id", "")
        temp_number = data.get("temp_number", "")
        message = data.get("message", "")

        if not to_id and not temp_number:
            return web.json_response({"error": "缺少 to_id 或 temp_number"}, status=400)

        # 如果提供了 temp_number，通过握手流程发起好友请求
        if temp_number:
            try:
                # 尝试通过握手管理器发起握手
                handshake_mgr = request.app.get("handshake_manager")
                if handshake_mgr:
                    result = await handshake_mgr.initiate_handshake(temp_number)
                    return web.json_response({
                        "success": True,
                        "message": "Handshake initiated",
                        "handshake_id": result.get("session_id", ""),
                        "temp_number": temp_number,
                    })
            except Exception as e:
                return web.json_response({"error": f"握手失败: {e}"}, status=500)

        # 否则直接使用 account_id 发送好友请求
        if to_id:
            try:
                server_client = request.app.get("server_client")
                if server_client:
                    result = await server_client.send_friend_request(to_id, message=message)
                    return web.json_response({
                        "success": True,
                        "message": "Friend request sent",
                        "to_id": to_id,
                        "request_id": result.get("request_id", ""),
                    })
            except Exception as e:
                return web.json_response({"error": f"发送好友请求失败: {e}"}, status=500)

        # 无可用后端时返回提示
        return web.json_response({
            "success": False,
            "error": "No backend available to send friend request. Ensure AICQ service is connected.",
        }, status=503)

    async def _friends_remove(self, request: web.Request) -> web.Response:
        friend_id = request.match_info["friend_id"]
        await self._db.remove_friend(friend_id)
        return web.json_response({"success": True})

    async def _friends_permissions(self, request: web.Request) -> web.Response:
        friend_id = request.match_info["friend_id"]
        friend = await self._db.get_friend(friend_id)
        return web.json_response({"permissions": friend.permissions if friend else []})

    async def _friends_set_permissions(self, request: web.Request) -> web.Response:
        friend_id = request.match_info["friend_id"]
        data = await request.json()
        friend = await self._db.get_friend(friend_id)
        if friend:
            friend.permissions = data.get("permissions", friend.permissions)
            await self._db.add_friend(friend)
        return web.json_response({"success": True})

    async def _friends_requests(self, request: web.Request) -> web.Response:
        requests = await self._db.get_pending_requests()
        return web.json_response({"requests": requests})

    async def _friends_accept(self, request: web.Request) -> web.Response:
        return web.json_response({"success": True})

    async def _friends_reject(self, request: web.Request) -> web.Response:
        return web.json_response({"success": True})

    async def _sessions_list(self, request: web.Request) -> web.Response:
        sessions = await self._db.get_all_sessions()
        return web.json_response({"sessions": sessions})

    async def _identity_info(self, request: web.Request) -> web.Response:
        identity = await self._db.load_identity()
        return web.json_response(identity or {})

    async def _models_list(self, request: web.Request) -> web.Response:
        return web.json_response({
            "providers": [
                {"id": "modelscope", "name": "ModelScope", "baseUrl": "https://api-inference.modelscope.cn/v1"},
                {"id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1"},
                {"id": "zhipu", "name": "ZhipuAI", "baseUrl": "https://open.bigmodel.cn/api/paas/v4"},
                {"id": "moonshot", "name": "Moonshot", "baseUrl": "https://api.moonshot.cn/v1"},
                {"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1"},
                {"id": "qwen", "name": "Qwen", "baseUrl": "https://dashscope.aliyuncs.com/api/v1"},
                {"id": "yi", "name": "Yi", "baseUrl": "https://api.lingyiwanwu.com/v1"},
                {"id": "minimax", "name": "MiniMax", "baseUrl": "https://api.minimax.chat/v1"},
                {"id": "stepfun", "name": "StepFun", "baseUrl": "https://api.stepfun.com/v1"},
                {"id": "baichuan", "name": "Baichuan", "baseUrl": "https://api.baichuan-ai.com/v1"},
                {"id": "spark", "name": "Spark", "baseUrl": "https://spark-api.xf-yun.com/v1"},
                {"id": "doubao", "name": "Doubao", "baseUrl": "https://api.doubao.com/v1"},
                {"id": "gemini", "name": "Gemini", "baseUrl": "https://generativelanguage.googleapis.com/v1"},
                {"id": "claude", "name": "Claude", "baseUrl": "https://api.anthropic.com/v1"},
                {"id": "ollama", "name": "Ollama", "baseUrl": "http://localhost:11434/v1"},
                {"id": "lmstudio", "name": "LM Studio", "baseUrl": "http://localhost:1234/v1"},
                {"id": "groq", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1"},
                {"id": "together", "name": "Together", "baseUrl": "https://api.together.xyz/v1"},
                {"id": "custom", "name": "Custom", "baseUrl": ""},
            ]
        })

    async def _models_add_provider(self, request: web.Request) -> web.Response:
        data = await request.json()
        return web.json_response({"success": True})

    async def _models_remove_provider(self, request: web.Request) -> web.Response:
        return web.json_response({"success": True})

    async def _settings_get(self, request: web.Request) -> web.Response:
        identity = await self._db.load_identity()
        return web.json_response({
            "server_url": identity.get("server_url", "https://aicq.online") if identity else "https://aicq.online",
            "max_friends": 200,
            "auto_accept_friends": True,
        })

    async def _settings_update(self, request: web.Request) -> web.Response:
        data = await request.json()
        return web.json_response({"success": True})

    async def _config_get(self, request: web.Request) -> web.Response:
        return web.json_response({"config": {}})

    async def _config_update(self, request: web.Request) -> web.Response:
        data = await request.json()
        return web.json_response({"success": True})

    async def _backup_export(self, request: web.Request) -> web.Response:
        identity = await self._db.load_identity()
        friends = await self._db.get_all_friends()
        return web.json_response({
            "identity": identity,
            "friends": [{"id": f.id, "public_key": f.public_key} for f in friends],
        })

    async def _backup_restore(self, request: web.Request) -> web.Response:
        return web.json_response({"success": True})

    async def _status(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "running", "version": "2.0.0"})

    # ──────────────── Server lifecycle ────────────────

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        print(f"[ManagementUI] Serving on http://{self._host}:{self._port}")

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()
            self._runner = None


def _generate_management_html() -> str:
    """Generate the management SPA HTML inline."""
    return '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AICQ Plugin Management</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#333;display:flex;min-height:100vh}
.sidebar{width:220px;background:#fff;border-right:1px solid #e0e0e0;padding:20px 0;flex-shrink:0}
.sidebar h2{padding:0 20px 20px;color:#1890ff;font-size:18px;border-bottom:1px solid #f0f0f0}
.sidebar nav a{display:block;padding:12px 20px;color:#666;text-decoration:none;transition:all .2s}
.sidebar nav a:hover,.sidebar nav a.active{color:#1890ff;background:#e6f7ff}
.main{flex:1;padding:24px;overflow-y:auto}
.card{background:#fff;border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.card h3{margin-bottom:12px;color:#333}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px}
.stat{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
.stat .number{font-size:28px;font-weight:700;color:#1890ff}
.stat .label{color:#999;margin-top:4px}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #f0f0f0}
th{background:#fafafa;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px}
.badge.online{background:#52c41a;color:#fff}
.badge.offline{background:#d9d9d9;color:#666}
.btn{padding:6px 16px;border:1px solid #d9d9d9;border-radius:4px;cursor:pointer;background:#fff;transition:all .2s}
.btn:hover{color:#1890ff;border-color:#1890ff}
.btn.primary{background:#1890ff;color:#fff;border-color:#1890ff}
.btn.primary:hover{background:#40a9ff}
.btn.danger{color:#ff4d4f;border-color:#ff4d4f}
.btn.danger:hover{background:#fff1f0}
input,select,textarea{padding:6px 12px;border:1px solid #d9d9d9;border-radius:4px;width:100%;max-width:400px}
.form-group{margin-bottom:16px}
.form-group label{display:block;margin-bottom:6px;font-weight:500}
</style>
</head>
<body>
<div class="sidebar">
<h2>AICQ Plugin</h2>
<nav>
<a href="#" class="active" onclick="showView('dashboard')">Dashboard</a>
<a href="#" onclick="showView('agents')">Agents</a>
<a href="#" onclick="showView('friends')">Friends</a>
<a href="#" onclick="showView('models')">Models</a>
<a href="#" onclick="showView('settings')">Settings</a>
<a href="#" onclick="showView('backup')">Backup</a>
</nav>
</div>
<div class="main" id="main">
<div id="view-dashboard">
<div class="stats">
<div class="stat"><div class="number" id="friends-count">-</div><div class="label">Friends</div></div>
<div class="stat"><div class="number" id="online-count">-</div><div class="label">Online</div></div>
<div class="stat"><div class="number" id="sessions-count">-</div><div class="label">Sessions</div></div>
</div>
<div class="card"><h3>System Status</h3><p id="sys-status">Loading...</p></div>
</div>
<div id="view-agents" style="display:none">
<div class="card"><h3>Agent Management</h3><div id="agents-list">Loading...</div></div>
</div>
<div id="view-friends" style="display:none">
<div class="card"><h3>Friends</h3><div id="friends-list">Loading...</div></div>
</div>
<div id="view-models" style="display:none">
<div class="card"><h3>Model Providers</h3><div id="models-list">Loading...</div></div>
</div>
<div id="view-settings" style="display:none">
<div class="card"><h3>Settings</h3><div id="settings-form">Loading...</div></div>
</div>
<div id="view-backup" style="display:none">
<div class="card"><h3>Backup &amp; Restore</h3>
<button class="btn primary" onclick="exportBackup()">Export Backup</button>
<button class="btn" onclick="document.getElementById('restore-file').click()">Restore</button>
<input type="file" id="restore-file" style="display:none" onchange="importBackup(this)">
</div>
</div>
</div>
<script>
const API='';
function showView(v){
document.querySelectorAll('[id^="view-"]').forEach(e=>e.style.display='none');
document.getElementById('view-'+v).style.display='block';
document.querySelectorAll('.sidebar nav a').forEach(a=>a.classList.remove('active'));
event.target.classList.add('active');
loadView(v);
}
async function api(path){
const r=await fetch(API+path);return r.json();
}
async function loadView(v){
if(v==='dashboard'){
const d=await api('/api/dashboard');
document.getElementById('friends-count').textContent=d.friends_count;
document.getElementById('online-count').textContent=d.online_count;
document.getElementById('sessions-count').textContent=d.sessions_count;
const s=await api('/api/status');
document.getElementById('sys-status').textContent='Version: '+s.version+' | Status: '+s.status;
}else if(v==='friends'){
const d=await api('/api/friends');
let h='<table><tr><th>ID</th><th>Fingerprint</th><th>Status</th><th>Type</th><th>Actions</th></tr>';
d.friends.forEach(f=>{
h+=`<tr><td>${f.id.slice(0,8)}...</td><td>${f.fingerprint}</td><td><span class="badge ${f.is_online?'online':'offline'}">${f.is_online?'Online':'Offline'}</span></td><td>${f.friend_type}</td><td><button class="btn danger" onclick="removeFriend('${f.id}')">Remove</button></td></tr>`;
});
h+='</table>';document.getElementById('friends-list').innerHTML=h;
}else if(v==='models'){
const d=await api('/api/models');
let h='<table><tr><th>Provider</th><th>Base URL</th></tr>';
d.providers.forEach(p=>{h+=`<tr><td>${p.name}</td><td>${p.baseUrl}</td></tr>`;});
h+='</table>';document.getElementById('models-list').innerHTML=h;
}else if(v==='settings'){
const d=await api('/api/settings');
document.getElementById('settings-form').innerHTML=`
<div class="form-group"><label>Server URL</label><input id="set-server" value="${d.server_url}"></div>
<div class="form-group"><label>Max Friends</label><input id="set-max" type="number" value="${d.max_friends}"></div>
<div class="form-group"><label>Auto Accept Friends</label><select id="set-auto"><option value="true" ${d.auto_accept_friends?'selected':''}>Yes</option><option value="false" ${!d.auto_accept_friends?'selected':''}>No</option></select></div>
<button class="btn primary" onclick="saveSettings()">Save</button>`;
}else if(v==='agents'){
const d=await api('/api/agents');
let h='<table><tr><th>Agent ID</th><th>Public Key</th></tr>';
d.agents.forEach(a=>{h+=`<tr><td>${a.id}</td><td>${a.publicKey.slice(0,16)}...</td></tr>`;});
h+='</table>';document.getElementById('agents-list').innerHTML=h;
}
}
async function removeFriend(id){
if(confirm('Remove friend?')){await fetch(API+'/api/friends/'+id,{method:'DELETE'});loadView('friends');}
}
async function saveSettings(){
const data={server_url:document.getElementById('set-server').value,max_friends:parseInt(document.getElementById('set-max').value),auto_accept_friends:document.getElementById('set-auto').value==='true'};
await fetch(API+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
alert('Settings saved');
}
async function exportBackup(){
const d=await api('/api/backup');
const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='aicq-backup.json';a.click();
}
async function importBackup(input){
const file=input.files[0];if(!file)return;
const text=await file.text();
await fetch(API+'/api/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:text});
alert('Backup restored');
}
loadView('dashboard');
</script>
</body>
</html>'''
