const express = require("express");
const http = require("http");
const path = require("path");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 1e5,
  connectTimeout: 20000
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get("/api/qr", async (req, res) => {
  try {
    const data = String(req.query.data || "");
    if (!data) return res.status(400).send("Missing data");
    const svg = await QRCode.toString(data, {
      type: "svg", margin: 1, width: 360, errorCorrectionLevel: "M"
    });
    res.set("Cache-Control", "public, max-age=86400");
    res.type("image/svg+xml").send(svg);
  } catch {
    res.status(500).send("QR generation failed");
  }
});

const DEFAULT_TEAMS = Array.from({ length: 10 }, (_, i) => `${i + 1}조`);

const ROUNDS = [
  { id:"innovation", group:"Core Value", value:"Innovation",
    left:"검증된 방식 활용", right:"새로운 방식 실험" },
  { id:"integrity", group:"Core Value", value:"Integrity",
    left:"상황에 맞춘 유연한 판단", right:"원칙과 기준의 일관성" },
  { id:"accountability", group:"Core Value", value:"Accountability",
    left:"내가 직접 해결", right:"역할을 명확히 하고 맡김" },
  { id:"inclusive", group:"Core Behavior", value:"Be inclusive & Embrace Diversity",
    left:"빠르게 의견을 모아 결론", right:"다양한 관점을 충분히 탐색" },
  { id:"trust", group:"Core Behavior", value:"Collaborate & Trust",
    left:"리더가 세부적으로 개입", right:"구성원에게 자율성 부여" },
  { id:"develop", group:"Core Behavior", value:"Develop & Grow",
    left:"답을 직접 제공", right:"질문으로 코칭" }
];

const sessions = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function points(distance) {
  if (distance <= 5) return 5;
  if (distance <= 10) return 4;
  if (distance <= 15) return 3;
  if (distance <= 20) return 2;
  if (distance <= 25) return 1;
  return 0;
}
function snapshot(s, host=false) {
  return {
    code:s.code, title:s.title, phase:s.phase, teams:s.teams,
    participants:[...s.participants.values()].map(p=>({
      id:p.id,name:p.name,team:p.team,connected:p.connected,score:p.score
    })),
    currentRound:s.currentRound ? {
      ...s.currentRound,
      target: host || s.phase==="revealed" ? s.currentRound.target : null
    } : null,
    clueGiverId:s.clueGiverId,
    clue:s.clue,
    voteCount:s.votes.size,
    teamScores:s.teamScores,
    lastResult:s.lastResult,
    rounds:s.rounds,
    completedRounds:s.completedRounds||[],
    allResults:s.allResults||[],
    isHostClueGiver:true
  };
}
function emitState(s) {
  io.to(s.code).emit("state", snapshot(s,false));
  if (s.hostSocketId) io.to(s.hostSocketId).emit("hostState", snapshot(s,true));
  io.to(`${s.code}:screen`).emit("screenState", snapshot(s,true));
}
function getSession(code){ return sessions.get(String(code||"").toUpperCase()); }

io.on("connection", socket => {

  socket.on("hostCreate", ({title}, cb) => {
    try {
      let code = makeCode();
      while (sessions.has(code)) code = makeCode();
      const s = {
        code,
        title: title || "CV/CB Leadership Debrief",
        hostSocketId: socket.id,
        hostToken: Math.random().toString(36).slice(2),
        teams:[...DEFAULT_TEAMS],
        participants:new Map(),
        teamScores:Object.fromEntries(DEFAULT_TEAMS.map(t=>[t,0])),
        rounds:ROUNDS,
        phase:"lobby",
        currentRound:null,
        clueGiverId:"__HOST__",
        clue:"",
        votes:new Map(),
        lastResult:null,
        completedRounds:[],
        allResults:[]
      };
      sessions.set(code,s);
      socket.join(code);
      cb?.({ok:true,code:s.code,hostToken:s.hostToken});
      emitState(s);
    } catch(e) { cb?.({ok:false,error:"세션 생성 실패"}); }
  });

  socket.on("hostResume", ({code,hostToken}, cb)=>{
    const s = getSession(code);
    if (!s || s.hostToken !== hostToken) return cb?.({ok:false});
    s.hostSocketId = socket.id;
    socket.join(s.code);
    cb?.({ok:true,state:snapshot(s,true)});
    emitState(s);
  });

  socket.on("screenJoin", ({code}, cb)=>{
    const s=getSession(code);
    if(!s) return cb?.({ok:false});
    socket.join(`${s.code}:screen`);
    cb?.({ok:true,state:snapshot(s,true)});
  });

  socket.on("join", ({code,name,team,participantId}, cb)=>{
    try {
      const s=getSession(code);
      if(!s) return cb?.({ok:false,error:"세션을 찾을 수 없습니다."});
      if(!name?.trim()) return cb?.({ok:false,error:"이름을 입력해 주세요."});
      if(!s.teams.includes(team)) return cb?.({ok:false,error:"조 정보를 확인해 주세요."});

      let p = participantId ? s.participants.get(participantId) : null;
      if(!p){
        if(s.participants.size >= 70) return cb?.({ok:false,error:"참가 인원이 가득 찼습니다."});
        participantId = Math.random().toString(36).slice(2,11);
        p={id:participantId,name:name.trim(),team,connected:true,score:0,socketId:socket.id};
        s.participants.set(participantId,p);
      }else{
        p.name=name.trim(); p.team=team; p.connected=true; p.socketId=socket.id;
      }
      socket.data.code=s.code;
      socket.data.pid=participantId;
      socket.join(s.code);
      cb?.({ok:true,participantId,state:snapshot(s,false)});
      emitState(s);
    } catch(e) { cb?.({ok:false,error:"입장 처리 중 오류"}); }
  });

  // Host is now always the Clue Giver - no participant selection needed
  socket.on("hostStartRound", ({code,roundId}, cb)=>{
    try {
      const s=getSession(code);
      if(!s || s.hostSocketId!==socket.id) return cb?.({ok:false,error:"Host 권한이 없습니다."});
      const r=s.rounds.find(x=>x.id===roundId);
      if(!r) return cb?.({ok:false,error:"라운드를 찾을 수 없습니다."});
      const connected=[...s.participants.values()].filter(p=>p.connected);
      if(!connected.length) return cb?.({ok:false,error:"참가자가 없습니다."});
      s.currentRound={...r,target:Math.floor(Math.random()*81)+10};
      s.clueGiverId="__HOST__"; s.clue=""; s.votes.clear(); s.phase="clue"; s.lastResult=null;
      cb?.({ok:true,target:s.currentRound.target});
      emitState(s);
    } catch(e) { cb?.({ok:false,error:"라운드 시작 실패"}); }
  });

  // Host submits the clue directly, optionally adjusting target
  socket.on("hostSubmitClue", ({code,clue,target}, cb)=>{
    const s=getSession(code);
    if(!s || s.hostSocketId!==socket.id || s.phase!=="clue")
      return cb?.({ok:false,error:"지금은 힌트를 제출할 수 없습니다."});
    if(!clue?.trim()) return cb?.({ok:false,error:"힌트를 입력해 주세요."});
    if(target!=null && s.currentRound){
      const t=Math.max(0,Math.min(100,Math.round(Number(target))));
      s.currentRound.target=t;
    }
    s.clue=clue.trim().slice(0,140);
    s.phase="voting";
    cb?.({ok:true});
    emitState(s);
  });

  socket.on("vote", ({code,participantId,value}, cb)=>{
    const s=getSession(code);
    if(!s || s.phase!=="voting") return cb?.({ok:false,error:"지금은 투표 시간이 아닙니다."});
    const p=s.participants.get(participantId);
    if(!p) return cb?.({ok:false,error:"참가자 정보를 찾을 수 없습니다."});
    const v=Math.max(0,Math.min(100,Number(value)));
    s.votes.set(participantId,v);
    cb?.({ok:true});
    emitState(s);
  });

  socket.on("hostReveal", ({code}, cb)=>{
    try {
      const s=getSession(code);
      if(!s || s.hostSocketId!==socket.id || !s.currentRound) return cb?.({ok:false});

      const individual=[...s.votes.entries()].map(([id,value])=>{
        const p=s.participants.get(id);
        const distance=Math.abs(value-s.currentRound.target);
        const pts=points(distance);
        if(p) p.score=(p.score||0)+pts;
        return {id,name:p?.name||"",team:p?.team||"",value,distance,points:pts};
      });

      const teamResults=s.teams.map(team=>{
        const vals=individual.filter(v=>v.team===team).map(v=>v.value);
        const avg=vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
        const distance=avg==null ? null : Math.abs(avg-s.currentRound.target);
        const pts=distance==null ? 0 : points(distance);
        s.teamScores[team]=(s.teamScores[team]||0)+pts;
        return {team,count:vals.length,avg,distance,points:pts};
      });

      s.lastResult={
        target:s.currentRound.target,
        round:s.currentRound,
        clue:s.clue,
        individual,
        teamResults
      };
      s.phase="revealed";
      if(!s.completedRounds) s.completedRounds=[];
      if(!s.completedRounds.includes(s.currentRound.id)) s.completedRounds.push(s.currentRound.id);
      if(!s.allResults) s.allResults=[];
      s.allResults.push(s.lastResult);
      io.to(s.code).emit("result",s.lastResult);
      io.to(`${s.code}:screen`).emit("result",s.lastResult);
      cb?.({ok:true});
      emitState(s);
    } catch(e) { cb?.({ok:false}); }
  });

  socket.on("hostLobby", ({code},cb)=>{
    const s=getSession(code);
    if(!s || s.hostSocketId!==socket.id) return cb?.({ok:false});
    s.phase="lobby"; s.currentRound=null; s.clue=""; s.clueGiverId="__HOST__"; s.votes.clear();
    cb?.({ok:true}); emitState(s);
  });

  socket.on("getFinalResults", ({code},cb)=>{
    const s=getSession(code);
    if(!s) return cb?.({ok:false});
    const individualTotal=[...s.participants.values()].map(p=>({
      id:p.id, name:p.name, team:p.team, score:p.score||0
    })).sort((a,b)=>b.score-a.score);
    const teamTotal=Object.entries(s.teamScores).map(([team,score])=>({team,score})).sort((a,b)=>b.score-a.score);
    cb?.({ok:true, individualTotal, teamTotal, roundCount:s.completedRounds?.length||0});
  });

  socket.on("hostResetScores", ({code},cb)=>{
    const s=getSession(code);
    if(!s || s.hostSocketId!==socket.id) return cb?.({ok:false});
    s.teams.forEach(t=>s.teamScores[t]=0);
    s.participants.forEach(p=>p.score=0);
    s.completedRounds=[];
    s.allResults=[];
    cb?.({ok:true}); emitState(s);
  });

  socket.on("disconnect",()=>{
    const s=getSession(socket.data.code);
    const p=s?.participants.get(socket.data.pid);
    if(p){ p.connected=false; emitState(s); }
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log(`CV/CB Spectrum Web running on port ${PORT}`));
