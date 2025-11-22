const App = (() => {
  
  const state = {
    mode: 'draw', activeTool: 'sketch', isDrawing: false,
    dragStart: {x:0, y:0}, dragCurrent: {x:0, y:0}, rawPoints: [],
    objects: [], lastObjectId: null, globalDepth: 2.0,
    simPath: [], simIndex: 0, simProgress: 0, simSpeedMultiplier: 1.0,
    history: [], historyStep: -1
  };

  const elements = {}; 

  function init() {
    elements.canvas = document.getElementById('canvas');
    elements.ctx = elements.canvas.getContext('2d');
    elements.consoleLog = document.getElementById('consoleLog');
    elements.voiceToast = document.getElementById('voiceToast');
    elements.simLegend = document.getElementById('simLegend');
    elements.dropdown = document.getElementById('shapeDropdown');
    elements.imgLoader = document.getElementById('imgLoader');
    elements.speedSlider = document.getElementById('simSpeedSlider');
    
    // Manual Inputs
    elements.inputs = {
        x: document.getElementById('inp-x'),
        y: document.getElementById('inp-y'),
        w: document.getElementById('inp-w'),
        h: document.getElementById('inp-h'),
        r: document.getElementById('inp-r'),
        d: document.getElementById('inp-d') // New Depth Input
    };

    resize();
    window.addEventListener('resize', resize);
    
    elements.canvas.addEventListener('pointerdown', onPointerDown);
    elements.canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    
    // Bind Manual Inputs
    ['x','y','w','h','r'].forEach(k => {
        if(elements.inputs[k]) elements.inputs[k].addEventListener('input', updateShapeFromInput);
    });
    
    // Bind Depth Input
    if(elements.inputs.d) {
        elements.inputs.d.addEventListener('input', (e) => {
            state.globalDepth = parseFloat(e.target.value) || 2.0;
        });
    }

    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; };
    bind('btnReset', clearCanvas); bind('btnUndo', undo); bind('exportBtn', generateGCode);
    bind('modeDraw', () => setMode('draw')); 
    bind('modeSim', () => { 
        if(state.objects.length===0){ log("Draw something first.", "err"); return; }
        prepareSim(); setMode('sim'); 
    });
    bind('btnImport', () => elements.imgLoader.click());
    elements.imgLoader.onchange = handleImageUpload;
    
    if(elements.speedSlider) {
        elements.speedSlider.oninput = (e) => {
            state.simSpeedMultiplier = parseFloat(e.target.value);
            document.getElementById('dispSpeed').textContent = state.simSpeedMultiplier.toFixed(1) + 'x';
        };
    }

    ['sketch', 'freehand', 'line', 'rect', 'circle'].forEach(tool => {
        bind(`tool-${tool}`, () => setTool(tool));
    });

    elements.dropdown.onchange = (e) => { setTool(e.target.value); e.target.blur(); };
    window.addEventListener('keydown', (e) => { if((e.ctrlKey||e.metaKey) && e.key==='z') {e.preventDefault();undo();} });

    initVoice();
    loop();
    log("System ready.", "sys");
  }

  function resize() {
    const parent = elements.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    elements.canvas.width = rect.width * dpr;
    elements.canvas.height = rect.height * dpr;
    elements.ctx.scale(dpr, dpr);
    render();
  }

  // --- MANUAL INPUT LOGIC ---
  function updateInputsFromSelection() {
    // Always ensure depth matches state
    if(elements.inputs.d) elements.inputs.d.value = state.globalDepth;

    const obj = state.objects.find(o => o.id === state.lastObjectId);
    if (!obj) {
        // Clear other inputs, but keep depth
        ['x','y','w','h','r'].forEach(k => elements.inputs[k].value = '');
        return;
    }
    const p = obj.params;
    const i = elements.inputs;
    
    // Disable unrelated fields
    i.r.disabled = (obj.type === 'rect' || obj.type === 'line');
    i.w.disabled = (obj.type === 'circle');
    i.h.disabled = (obj.type === 'circle' || obj.type === 'line');

    if(obj.type === 'circle' || obj.type.includes('gon') || obj.type === 'star') {
        i.x.value = Math.round(p.cx); i.y.value = Math.round(p.cy); i.r.value = Math.round(p.radius);
    } else if (obj.type === 'rect') {
        i.x.value = Math.round(p.x); i.y.value = Math.round(p.y); i.w.value = Math.round(p.w); i.h.value = Math.round(p.h);
    } else if (obj.type === 'line') {
        i.x.value = Math.round(p.x1); i.y.value = Math.round(p.y1); 
        i.w.value = Math.round(p.x2); i.h.value = Math.round(p.y2);
    }
  }

  function updateShapeFromInput() {
    const obj = state.objects.find(o => o.id === state.lastObjectId);
    if(!obj) return;
    const i = elements.inputs, p = obj.params;
    const v = (el) => parseFloat(el.value) || 0;

    if(obj.type === 'circle' || obj.type.includes('gon') || obj.type === 'star') {
        p.cx = v(i.x); p.cy = v(i.y); p.radius = v(i.r);
    } else if (obj.type === 'rect') {
        p.x = v(i.x); p.y = v(i.y); p.w = v(i.w); p.h = v(i.h);
    } else if (obj.type === 'line') {
        p.x1 = v(i.x); p.y1 = v(i.y); p.x2 = v(i.w); p.y2 = v(i.h);
    }
    saveState(); render();
  }

  // --- DRAWING LOGIC ---
  function onPointerDown(e) {
    if (state.mode !== 'draw') return;
    
    // Check click select
    const clickedObj = checkObjectClick(e.offsetX, e.offsetY);
    if (clickedObj) {
        state.lastObjectId = clickedObj.id;
        updateInputsFromSelection(); render(); return;
    }

    state.isDrawing = true;
    state.dragStart = {x: snap(e.offsetX), y: snap(e.offsetY)};
    state.dragCurrent = {x: snap(e.offsetX), y: snap(e.offsetY)};
    if (state.activeTool === 'sketch' || state.activeTool === 'freehand') state.rawPoints = [{x: e.offsetX, y: e.offsetY}];
    elements.canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!state.isDrawing) return;
    state.dragCurrent = {x: snap(e.offsetX), y: snap(e.offsetY)};
    if (state.activeTool === 'sketch' || state.activeTool === 'freehand') {
        const last = state.rawPoints[state.rawPoints.length-1];
        if(Math.hypot(e.offsetX - last.x, e.offsetY - last.y) > 2) state.rawPoints.push({x: e.offsetX, y: e.offsetY});
    }
  }

  function onPointerUp(e) {
    if (!state.isDrawing) return;
    state.isDrawing = false;
    if (state.activeTool === 'sketch') recognizeSketch(state.rawPoints);
    else if (state.activeTool === 'freehand') {
        if(state.rawPoints.length > 5) addObject({ id: Date.now(), type: 'freehand', params: { points: [...state.rawPoints] }});
    } else createShapeFromDrag();
    state.rawPoints = [];
  }

  function checkObjectClick(x, y) {
    for(let i = state.objects.length - 1; i >= 0; i--) {
        const o = state.objects[i], p = o.params;
        if (o.type === 'rect') { if(x>=p.x && x<=p.x+p.w && y>=p.y && y<=p.y+p.h) return o; }
        else if (o.type === 'circle') { if(Math.hypot(x-p.cx, y-p.cy) <= p.radius) return o; }
    }
    return null;
  }

  function createShapeFromDrag() {
    const s = state.dragStart, e = state.dragCurrent, dx = e.x - s.x, dy = e.y - s.y;
    if (Math.hypot(dx, dy) < 5) return;
    const obj = { id: Date.now(), type: state.activeTool, params: {} };
    if (state.activeTool === 'line') obj.params = {x1:s.x, y1:s.y, x2:e.x, y2:e.y};
    else if (state.activeTool === 'rect') obj.params = {x:Math.min(s.x,e.x), y:Math.min(s.y,e.y), w:Math.abs(dx), h:Math.abs(dy)};
    else if (state.activeTool === 'circle') obj.params = {cx:(s.x+e.x)/2, cy:(s.y+e.y)/2, radius:Math.hypot(dx,dy)/2};
    else obj.params = { cx: s.x, cy: s.y, radius: Math.hypot(dx, dy) };
    addObject(obj);
  }

  // --- RENDER ---
  function render() {
    const ctx = elements.ctx;
    const dpr = window.devicePixelRatio||1;
    const w = elements.canvas.width/dpr, h = elements.canvas.height/dpr;
    ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 0.5; ctx.beginPath();
    for(let x=0; x<w; x+=50){ctx.moveTo(x,0);ctx.lineTo(x,h);} 
    for(let y=0; y<h; y+=50){ctx.moveTo(0,y);ctx.lineTo(w,y);} ctx.stroke();

    const drawFunc = (state.mode === 'draw') ? (obj) => drawShape(obj) : (obj) => { ctx.globalAlpha=0.2; drawShape(obj); ctx.globalAlpha=1.0; };
    state.objects.forEach(drawFunc);

    if (state.isDrawing && !['sketch','freehand'].includes(state.activeTool)) {
        ctx.strokeStyle = '#3b82f6'; ctx.setLineDash([5,5]); ctx.beginPath();
        const s=state.dragStart, e=state.dragCurrent;
        if(state.activeTool==='line'){ ctx.moveTo(s.x,s.y); ctx.lineTo(e.x,e.y); }
        else if(state.activeTool==='rect'){ ctx.rect(Math.min(s.x,e.x), Math.min(s.y,e.y), Math.abs(e.x-s.x), Math.abs(e.y-s.y)); }
        else if(state.activeTool==='circle'){ ctx.arc((s.x+e.x)/2, (s.y+e.y)/2, Math.hypot(e.x-s.x,e.y-s.y)/2, 0, Math.PI*2); }
        ctx.stroke(); ctx.setLineDash([]);
    }
    if (state.isDrawing && ['sketch','freehand'].includes(state.activeTool) && state.rawPoints.length) {
        ctx.strokeStyle = '#3b82f6'; ctx.lineWidth=2; ctx.beginPath();
        ctx.moveTo(state.rawPoints[0].x, state.rawPoints[0].y); 
        for(let p of state.rawPoints) ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    if (state.mode === 'sim' && state.simPath.length > 1) {
        updateSim();
        for(let i=0; i<state.simIndex; i++) {
            const p1=state.simPath[i], p2=state.simPath[i+1];
            ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = p2.type==='cut'?'#238636':'#ef4444'; ctx.lineWidth = p2.type==='cut'?2:0.5;
            if(p2.type!=='cut') ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
        }
        if(state.simIndex < state.simPath.length - 1) {
            const s=state.simPath[state.simIndex], e=state.simPath[state.simIndex+1];
            const cx = s.x + (e.x - s.x) * state.simProgress, cy = s.y + (e.y - s.y) * state.simProgress;
            ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(cx, cy);
            ctx.strokeStyle = e.type==='cut'?'#238636':'#ef4444'; ctx.lineWidth = e.type==='cut'?2:0.5;
            if(e.type!=='cut') ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = '#00e5ff'; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI*2); ctx.fill();
        }
    }
  }

  function drawShape(obj) {
    const ctx = elements.ctx; ctx.beginPath();
    const isSel = (obj.id === state.lastObjectId); 
    ctx.strokeStyle = isSel ? '#3b82f6' : '#e6edf3'; ctx.lineWidth = isSel ? 3 : 2;
    const p = obj.params;
    
    if (obj.type==='line') { ctx.moveTo(p.x1,p.y1); ctx.lineTo(p.x2,p.y2); }
    else if (obj.type==='freehand' && p.points.length > 0) { 
        ctx.moveTo(p.points[0].x, p.points[0].y); 
        p.points.forEach(pt => ctx.lineTo(pt.x, pt.y)); 
    }
    else if (obj.type==='rect') ctx.rect(p.x,p.y,p.w,p.h);
    else if (obj.type==='circle') ctx.arc(p.cx,p.cy,p.radius,0,Math.PI*2);
    else {
        let si=3, st=false;
        if(obj.type.includes('tri')) si=3; if(obj.type.includes('pent')) si=5; if(obj.type.includes('hex')) si=6;
        if(obj.type.includes('oct')) si=8; if(obj.type.includes('dec')) si=10; if(obj.type==='star') {si=5;st=true;} if(obj.type==='burst') {si=8;st=true;}
        const pts = getPolygonVertices(p.cx, p.cy, p.radius, si, st);
        ctx.moveTo(pts[0].x, pts[0].y); pts.forEach(pt => ctx.lineTo(pt.x, pt.y)); ctx.closePath();
    }
    ctx.stroke();
  }

  // --- HELPERS ---
  function addObject(obj) {
    state.objects.push(obj);
    state.lastObjectId = obj.id;
    saveState(); updateInputsFromSelection(); 
    log(`Created ${obj.type}`, 'sys');
  }

  function recognizeSketch(pts) {
    if (pts.length < 5) return;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
    const w=maxX-minX, h=maxY-minY, gap = Math.hypot(pts[pts.length-1].x - pts[0].x, pts[pts.length-1].y - pts[0].y);
    const obj = { id:Date.now(), type:'unknown', params:{} };
    if (gap > Math.hypot(w,h)*0.35) { obj.type='line'; obj.params={x1:pts[0].x, y1:pts[0].y, x2:pts[pts.length-1].x, y2:pts[pts.length-1].y}; } 
    else { if (w>h?h/w:w/h > 0.8) { obj.type='circle'; obj.params={cx:minX+w/2, cy:minY+h/2, radius:Math.max(w,h)/2}; } else { obj.type='rect'; obj.params={x:minX, y:minY, w:w, h:h}; } }
    addObject(obj);
  }

  function getPolygonVertices(cx, cy, radius, sides, isStar) {
    const pts = [], step = (Math.PI*2)/sides, start = -Math.PI/2;
    const loops = isStar ? sides*2 : sides, inner = radius*0.4, sStep = Math.PI/sides;
    for (let i=0; i<loops; i++) {
        const r = isStar ? ((i%2===0)?radius:inner) : radius;
        const a = isStar ? start+sStep*i : start+step*i;
        pts.push({x: cx + r*Math.cos(a), y: cy + r*Math.sin(a)});
    }
    return pts;
  }

  function saveState() {
    if (state.historyStep < state.history.length - 1) state.history = state.history.slice(0, state.historyStep + 1);
    state.history.push(JSON.parse(JSON.stringify(state.objects)));
    state.historyStep++;
  }

  function undo() {
    if (state.historyStep > 0) {
        state.historyStep--;
        state.objects = JSON.parse(JSON.stringify(state.history[state.historyStep]));
        render(); log("Undo performed.", 'sys');
    }
  }

  function snap(val) { return (state.activeTool === 'freehand') ? val : (Math.abs(val - (Math.round(val/50)*50)) < 10 ? (Math.round(val/50)*50) : val); }

  function setTool(tool) {
    state.activeTool = tool;
    document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
    if(elements.dropdown) elements.dropdown.value = ""; 
    const btn = document.getElementById('tool-'+tool);
    if(btn) btn.classList.add('active'); else if(elements.dropdown) elements.dropdown.value = tool;
    setMode('draw'); log(`Tool: ${tool.toUpperCase()}`, 'sys');
  }

  function setMode(m) {
    state.mode = m;
    const d = document.getElementById('modeDraw'), s = document.getElementById('modeSim');
    if(d) d.className = m==='draw'?'tool-btn active':'tool-btn';
    if(s) s.className = m==='sim'?'tool-btn active':'tool-btn';
    if(elements.simLegend) elements.simLegend.className = m==='sim'?'sim-legend visible':'sim-legend';
    render();
  }

  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn=document.getElementById('micBtn'), txt=document.getElementById('micText');
    if(!SR) { txt.textContent="No Voice Support"; return; }
    const rec = new SR(); rec.continuous=false;
    btn.onmousedown=()=>{try{rec.start();}catch(e){};btn.classList.add('active');txt.textContent="Listening...";};
    btn.onmouseup=()=>{setTimeout(()=>{try{rec.stop();}catch(e){};btn.classList.remove('active');txt.textContent="Click to Speak";},500);};
    rec.onresult=(e)=>{const t=e.results[0][0].transcript.toLowerCase(); showToast(`"${t}"`); log(`Heard: "${t}"`,'cmd'); parseCommand(t);};
  }

  function parseCommand(cmd) {
    const map={'one':1,'two':2,'three':3,'four':4,'five':5,'ten':10,'twenty':20,'thirty':30,'forty':40,'fifty':50,'hundred':100};
    let val = null; const m=cmd.match(/(\d+(\.\d+)?)/); if(m) val=parseFloat(m[0]);
    for(let k in map) if(cmd.includes(k)) val=map[k];
    if(cmd.includes('clear')||cmd.includes('reset')){clearCanvas();return;}
    if(cmd.includes('undo')){undo();return;}
    
    if(val===null && !cmd.includes('draw')) return;
    let mult=1; if(cmd.includes('cm')) mult=10; if(cmd.includes('inch')) mult=25.4;
    const num = val*mult;
    const obj = state.objects.find(o=>o.id===state.lastObjectId);
    if(!obj) { log("Select shape first.", "err"); return; }
    
    let mod=false;
    if((obj.type==='rect') && (cmd.includes('width')||cmd.includes('length'))){obj.params.w=num; mod=true;}
    if((obj.type==='rect') && (cmd.includes('height')||cmd.includes('tall'))){obj.params.h=num; mod=true;}
    if((obj.type==='circle'||obj.type.includes('gon')||obj.type==='star') && cmd.includes('radius')){obj.params.radius=num; mod=true;}
    
    if(mod) { saveState(); updateInputsFromSelection(); render(); log("Updated by voice.", 'sys'); }
  }

  function handleImageUpload(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { const img = new Image(); img.onload = () => traceImage(img); img.src = ev.target.result; };
    reader.readAsDataURL(file);
    e.target.value = ''; 
  }

  function traceImage(img) {
    log("Processing...", "sys");
    const w = 150, scale = 150 / img.width, h = Math.round(img.height * scale);
    const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
    const tctx = tc.getContext('2d'); tctx.fillStyle='white'; tctx.fillRect(0,0,w,h); tctx.drawImage(img,0,0,w,h);
    const data = tctx.getImageData(0,0,w,h).data;
    const getB = (i) => (data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114);
    const dpr = window.devicePixelRatio||1;
    const offX = (elements.canvas.width/dpr - w*2)/2, offY = (elements.canvas.height/dpr - h*2)/2, zoom=2;
    const edges = [];
    for(let y=0; y<h; y++) {
        for(let x=0; x<w; x++) {
            const b = getB((y*w+x)*4);
            if(x<w-1 && Math.abs(b - getB((y*w+x+1)*4))>50) edges.push({type:'line', id:Date.now()+Math.random(), params:{x1:offX+x*zoom, y1:offY+y*zoom, x2:offX+(x+1)*zoom, y2:offY+y*zoom}});
            if(y<h-1 && Math.abs(b - getB(((y+1)*w+x)*4))>50) edges.push({type:'line', id:Date.now()+Math.random(), params:{x1:offX+x*zoom, y1:offY+y*zoom, x2:offX+x*zoom, y2:offY+(y+1)*zoom}});
        }
    }
    if(edges.length) {
        const max = 3000;
        state.objects.push(...(edges.length>max ? edges.slice(0,max) : edges));
        saveState(); render(); log(`Imported ${Math.min(edges.length, max)} vectors.`, "success");
    } else log("No contrast found.", "err");
  }

  function prepareSim() {
    state.simPath = []; state.simIndex = 0; state.simProgress = 0;
    if (!state.objects.length) return;
    const dpr = window.devicePixelRatio||1, h = elements.canvas.height/dpr;
    state.simPath.push({x:0, y:h, type:'rapid'}); 
    const add = (x,y,t) => state.simPath.push({x,y,type:t});
    state.objects.forEach(obj => {
      const p = obj.params;
      if (obj.type === 'line') { add(p.x1, p.y1, 'rapid'); add(p.x2, p.y2, 'cut'); }
      else if (obj.type === 'freehand' && p.points && p.points.length) {
         add(p.points[0].x, p.points[0].y, 'rapid');
         p.points.forEach(pt => add(pt.x, pt.y, 'cut'));
      } else if (obj.type === 'rect') {
        add(p.x, p.y, 'rapid'); add(p.x+p.w, p.y, 'cut'); add(p.x+p.w, p.y+p.h, 'cut'); add(p.x, p.y+p.h, 'cut'); add(p.x, p.y, 'cut');
      } else if (obj.type === 'circle') {
        add(p.cx+p.radius, p.cy, 'rapid');
        for(let i=1; i<=30; i++) { const a=(i/30)*Math.PI*2; add(p.cx+Math.cos(a)*p.radius, p.cy+Math.sin(a)*p.radius, 'cut'); }
      } else {
        let s=3, st=false;
        if(obj.type.includes('tri')) s=3; if(obj.type.includes('pent')) s=5; if(obj.type.includes('hex')) s=6;
        if(obj.type.includes('oct')) s=8; if(obj.type.includes('dec')) s=10; if(obj.type==='star') {s=5;st=true;}
        const pts = getPolygonVertices(p.cx, p.cy, p.radius, s, st);
        add(pts[0].x, pts[0].y, 'rapid'); pts.slice(1).forEach(pt => add(pt.x, pt.y, 'cut')); add(pts[0].x, pts[0].y, 'cut');
      }
      let ex=0, ey=0;
      if(obj.type==='freehand'&&p.points&&p.points.length){ex=p.points[p.points.length-1].x; ey=p.points[p.points.length-1].y;}
      else if(obj.type.includes('gon')||obj.type==='star'||obj.type==='burst'||obj.type==='circle'){ex=p.cx+p.radius; ey=p.cy;} 
      else if(obj.type==='rect'){ex=p.x; ey=p.y;} else {ex=p.x2||p.x1; ey=p.y2||p.y1;} 
      add(ex, ey, 'rapid_up');
    });
    state.simPath.push({x:0, y:h, type:'rapid'});
  }

  function updateSim() {
    if (state.simIndex >= state.simPath.length-1) return;
    state.simProgress += 0.02 * state.simSpeedMultiplier;
    if (state.simProgress >= 1) { state.simProgress=0; state.simIndex++; }
  }

  function generateGCode() {
    if (!state.objects.length) return log("Empty canvas.", "err");
    let c = ["%", "(Sketch2Code Export)", `(Depth: ${state.globalDepth}mm)`, "G21 G90 G17", "G0 Z5", "M3 S12000"];
    const d = state.globalDepth, f = n => n.toFixed(3);
    state.objects.forEach((obj, i) => {
      c.push(`(Shape ${i+1}: ${obj.type})`); const p = obj.params;
      if (obj.type === 'line') { c.push(`G0 X${f(p.x1)} Y${f(p.y1)}`, `G1 Z-${d} F200`, `G1 X${f(p.x2)} Y${f(p.y2)} F800`); }
      else if (obj.type === 'freehand' && p.points && p.points.length) {
         c.push(`G0 X${f(p.points[0].x)} Y${f(p.points[0].y)}`, `G1 Z-${d} F200`);
         p.points.forEach(pt => c.push(`G1 X${f(pt.x)} Y${f(pt.y)} F800`));
      } else if (obj.type === 'rect') {
         c.push(`G0 X${f(p.x)} Y${f(p.y)}`, `G1 Z-${d} F200`, `G1 X${f(p.x+p.w)} Y${f(p.y)} F800`, `G1 X${f(p.x+p.w)} Y${f(p.y+p.h)}`, `G1 X${f(p.x)} Y${f(p.y+p.h)}`, `G1 X${f(p.x)} Y${f(p.y)}`);
      } else if (obj.type === 'circle') {
         c.push(`G0 X${f(p.cx+p.radius)} Y${f(p.cy)}`, `G1 Z-${d} F200`, `G3 X${f(p.cx+p.radius)} Y${f(p.cy)} I-${f(p.radius)} J0 F800`);
      } else {
         let si=3, st=false;
         if(obj.type.includes('tri')) si=3; if(obj.type.includes('pent')) si=5; if(obj.type.includes('hex')) si=6;
         if(obj.type.includes('oct')) si=8; if(obj.type.includes('dec')) si=10; if(obj.type==='star') {si=5;st=true;}
         const pts = getPolygonVertices(p.cx, p.cy, p.radius, si, st);
         c.push(`G0 X${f(pts[0].x)} Y${f(pts[0].y)}`, `G1 Z-${d} F200`);
         for(let k=1; k<pts.length; k++) c.push(`G1 X${f(pts[k].x)} Y${f(pts[k].y)} F800`);
         c.push(`G1 X${f(pts[0].x)} Y${f(pts[0].y)}`);
      }
      c.push("G0 Z5");
    });
    c.push("M5", "M30", "%");
    const blob = new Blob([c.join('\n')], {type:'text/plain'});
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'sketch2code.nc'; link.click();
    log("G-Code Exported.", "sys");
  }

  function log(m, t) { const d=document.createElement('div');d.className='log-item';d.innerHTML=`<span class="log-${t}">${m}</span>`;elements.consoleLog.prepend(d); }
  function showToast(m) { elements.voiceToast.textContent=m; elements.voiceToast.style.opacity=1; setTimeout(()=>elements.voiceToast.style.opacity=0,2000); }
  function clearCanvas() { state.objects=[]; state.lastObjectId=null; saveState(); updateInputsFromSelection(); render(); log("Cleared.", 'sys'); }
  function loop() { if(state.mode==='sim') render(); requestAnimationFrame(loop); }
  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);