const App = (() => {
  
  const state = {
    mode: 'draw',
    activeTool: 'sketch',
    isDrawing: false,
    dragStart: {x:0, y:0},
    dragCurrent: {x:0, y:0},
    rawPoints: [],
    objects: [],
    lastObjectId: null,
    globalDepth: 2.0,
    simPath: [],
    simIndex: 0,
    simProgress: 0,
    history: [],
    historyStep: -1
  };

  const elements = {}; 

  function init() {
    console.log("App initializing...");
    
    // Cache elements safely
    elements.canvas = document.getElementById('canvas');
    elements.ctx = elements.canvas ? elements.canvas.getContext('2d') : null;
    elements.consoleLog = document.getElementById('consoleLog');
    elements.voiceToast = document.getElementById('voiceToast');
    elements.simLegend = document.getElementById('simLegend');
    elements.dropdown = document.getElementById('shapeDropdown');
    elements.imgLoader = document.getElementById('imgLoader');

    if (!elements.canvas) {
        console.error("Canvas element missing! Check HTML.");
        return;
    }

    console.log("Canvas found, setting up...");

    resize();
    window.addEventListener('resize', resize);
    
    // Mouse/Touch Events - FIXED
    elements.canvas.addEventListener('pointerdown', onPointerDown);
    elements.canvas.addEventListener('pointermove', onPointerMove);
    elements.canvas.addEventListener('pointerup', onPointerUp);
    elements.canvas.addEventListener('pointercancel', onPointerUp);
    
    // Helper to safe bind
    const bind = (id, fn) => { 
      const el = document.getElementById(id); 
      if(el) {
        el.onclick = fn;
        console.log(`Bound ${id}`);
      } else {
        console.warn(`Element ${id} not found`);
      }
    };

    bind('btnReset', clearCanvas);
    bind('btnUndo', undo);
    bind('exportBtn', generateGCode);
    bind('modeDraw', () => setMode('draw'));
    bind('modeSim', () => { prepareSim(); setMode('sim'); });
    
    // Image Import
    bind('btnImport', () => { if(elements.imgLoader) elements.imgLoader.click(); });
    if(elements.imgLoader) elements.imgLoader.onchange = handleImageUpload;

    // Quick Tool Buttons - FIXED
    ['sketch', 'line', 'rect', 'circle'].forEach(tool => {
        const btn = document.getElementById(`tool-${tool}`);
        if(btn) {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setTool(tool);
            console.log(`Tool selected: ${tool}`);
          });
        }
    });

    // Dropdown Event - FIXED
    if(elements.dropdown) {
        elements.dropdown.addEventListener('change', (e) => {
            const tool = e.target.value;
            if(tool) {
              setTool(tool);
              console.log(`Dropdown tool selected: ${tool}`);
            }
        });
    }
    
    // Keyboard Undo
    window.addEventListener('keydown', (e) => {
        if((e.ctrlKey || e.metaKey) && e.key === 'z') { 
          e.preventDefault(); 
          undo(); 
        }
    });

    initVoice();
    saveState();
    loop();
    log("System ready. Select a tool and draw!", "sys");
    console.log("Init complete. Active tool:", state.activeTool);
  }

  function resize() {
    if(!elements.canvas) return;
    const parent = elements.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    elements.canvas.width = rect.width * dpr;
    elements.canvas.height = rect.height * dpr;
    elements.canvas.style.width = rect.width + 'px';
    elements.canvas.style.height = rect.height + 'px';
    elements.ctx.scale(dpr, dpr);
    render();
  }

  // --- IMAGE PROCESSING ---
  function handleImageUpload(e) {
    const file = e.target.files[0];
    if(!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => traceImage(img);
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = ''; 
  }

  function traceImage(img) {
    log("Processing image...", "sys");
    
    const scaleFactor = 150 / img.width;
    const w = 150;
    const h = Math.round(img.height * scaleFactor);
    
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const tmpCtx = tmpCanvas.getContext('2d');
    
    tmpCtx.fillStyle = 'white';
    tmpCtx.fillRect(0,0,w,h);
    tmpCtx.drawImage(img, 0, 0, w, h);
    
    const imgData = tmpCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const edges = [];
    const getB = (i) => (data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114);

    const dpr = window.devicePixelRatio || 1;
    const offsetX = (elements.canvas.width/dpr - w*2) / 2;
    const offsetY = (elements.canvas.height/dpr - h*2) / 2;
    const zoom = 2; 

    for(let y=0; y<h; y++) {
        for(let x=0; x<w; x++) {
            const i = (y * w + x) * 4;
            const brightness = getB(i);
            
            if(x < w-1) {
                const iRight = (y * w + (x+1)) * 4;
                if(Math.abs(brightness - getB(iRight)) > 50) {
                    edges.push({
                        type: 'line', id: Date.now() + Math.random(),
                        params: { x1: offsetX+x*zoom, y1: offsetY+y*zoom, x2: offsetX+(x+1)*zoom, y2: offsetY+y*zoom }
                    });
                }
            }
            if(y < h-1) {
                const iBottom = ((y+1) * w + x) * 4;
                if(Math.abs(brightness - getB(iBottom)) > 50) {
                    edges.push({
                        type: 'line', id: Date.now() + Math.random(),
                        params: { x1: offsetX+x*zoom, y1: offsetY+y*zoom, x2: offsetX+x*zoom, y2: offsetY+(y+1)*zoom }
                    });
                }
            }
        }
    }

    if(edges.length > 0) {
        const maxLines = 3000;
        if(edges.length > maxLines) {
            log(`Image complex. Limiting to ${maxLines} vectors.`, "err");
            state.objects.push(...edges.slice(0, maxLines));
        } else {
            state.objects.push(...edges);
        }
        saveState();
        render();
        log(`Imported ${Math.min(edges.length, maxLines)} vectors.`, "sys");
    } else {
        log("No contrast detected.", "err");
    }
  }

  function saveState() {
    if (state.historyStep < state.history.length - 1) {
      state.history = state.history.slice(0, state.historyStep + 1);
    }
    state.history.push(JSON.parse(JSON.stringify(state.objects)));
    state.historyStep++;
  }

  function undo() {
    if (state.historyStep > 0) {
        state.historyStep--;
        state.objects = JSON.parse(JSON.stringify(state.history[state.historyStep]));
        render();
        log("Undo performed.", 'sys');
    } else {
        log("Nothing to undo.", 'err');
    }
  }

  function snap(val) {
    const gridSize = 50;
    const threshold = 10;
    const nearest = Math.round(val / gridSize) * gridSize;
    return Math.abs(val - nearest) < threshold ? nearest : val;
  }

  function setTool(tool) {
    console.log("setTool called with:", tool);
    state.activeTool = tool;
    
    // Update UI
    document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
    
    const btn = document.getElementById('tool-'+tool);
    if(btn) {
      btn.classList.add('active');
    }
    
    // Update dropdown if needed
    if(elements.dropdown) {
      if(['triangle', 'pentagon', 'hexagon', 'octagon', 'decagon', 'star', 'burst'].includes(tool)) {
        elements.dropdown.value = tool;
      } else {
        elements.dropdown.value = "";
      }
    }
    
    setMode('draw');
    log(`Tool: ${tool.toUpperCase()}`, 'sys');
  }

  function setMode(m) {
    state.mode = m;
    const d = document.getElementById('modeDraw'); 
    const s = document.getElementById('modeSim');
    if(d) d.className = m==='draw' ? 'tool-btn active' : 'tool-btn';
    if(s) s.className = m==='sim' ? 'tool-btn active' : 'tool-btn';
    if (elements.simLegend) {
      elements.simLegend.className = m==='sim' ? 'sim-legend visible' : 'sim-legend';
    }
    render();
  }

  function getPolygonVertices(cx, cy, radius, sides, isStar = false) {
    const pts = [];
    const step = (Math.PI * 2) / sides;
    const startAngle = -Math.PI / 2;
    
    if (!isStar) {
        for (let i = 0; i < sides; i++) {
            pts.push({ 
              x: cx + radius * Math.cos(startAngle + step * i), 
              y: cy + radius * Math.sin(startAngle + step * i) 
            });
        }
    } else {
        const innerRadius = radius * 0.4;
        const starStep = Math.PI / sides; 
        for (let i = 0; i < sides * 2; i++) {
            const r = (i % 2 === 0) ? radius : innerRadius;
            pts.push({ 
              x: cx + r * Math.cos(startAngle + starStep * i), 
              y: cy + r * Math.sin(startAngle + starStep * i) 
            });
        }
    }
    return pts;
  }

  function prepareSim() {
    state.simPath = [];
    state.simIndex = 0;
    state.simProgress = 0;
    if (state.objects.length === 0) return;
    
    const dpr = window.devicePixelRatio || 1;
    const h = elements.canvas ? elements.canvas.height / dpr : 0;
    state.simPath.push({x:0, y:h, type:'rapid'}); 

    state.objects.forEach(obj => {
      const p = obj.params;
      const addMove = (x, y, type) => state.simPath.push({x, y, type});

      if (obj.type === 'line') {
        addMove(p.x1, p.y1, 'rapid'); 
        addMove(p.x2, p.y2, 'cut');
      } else if (obj.type === 'rect') {
        addMove(p.x, p.y, 'rapid');
        addMove(p.x + p.w, p.y, 'cut'); 
        addMove(p.x + p.w, p.y + p.h, 'cut');
        addMove(p.x, p.y + p.h, 'cut'); 
        addMove(p.x, p.y, 'cut');
      } else if (obj.type === 'circle') {
        addMove(p.cx + p.radius, p.cy, 'rapid');
        for(let i=1; i<=30; i++) {
            const angle = (i / 30) * Math.PI * 2;
            addMove(
              p.cx + Math.cos(angle) * p.radius, 
              p.cy + Math.sin(angle) * p.radius, 
              'cut'
            );
        }
      } else {
        let sides = 3; 
        let isStar = false;
        
        if(obj.type === 'triangle') sides = 3;
        if(obj.type === 'pentagon') sides = 5;
        if(obj.type === 'hexagon') sides = 6;
        if(obj.type === 'octagon') sides = 8;
        if(obj.type === 'decagon') sides = 10;
        if(obj.type === 'star') { sides = 5; isStar = true; }
        if(obj.type === 'burst') { sides = 8; isStar = true; }

        const pts = getPolygonVertices(p.cx, p.cy, p.radius, sides, isStar);
        addMove(pts[0].x, pts[0].y, 'rapid');
        pts.slice(1).forEach(pt => addMove(pt.x, pt.y, 'cut'));
        addMove(pts[0].x, pts[0].y, 'cut'); 
      }
      
      const safeX = p.x !== undefined ? p.x : p.cx || p.x1;
      const safeY = p.y !== undefined ? p.y : p.cy || p.y1;
      addMove(safeX, safeY, 'rapid_up'); 
    });
    
    state.simPath.push({x:0, y:h, type:'rapid'});
  }

  function updateSim() {
    if (state.simIndex >= state.simPath.length - 1) return;
    state.simProgress += 0.05;
    if (state.simProgress >= 1) { 
      state.simProgress = 0; 
      state.simIndex++; 
    }
  }

  function onPointerDown(e) {
    console.log("Pointer down!", "Mode:", state.mode, "Tool:", state.activeTool);
    
    if (state.mode !== 'draw') return;
    
    e.preventDefault();
    
    state.isDrawing = true;
    
    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    state.dragStart = {x: snap(x), y: snap(y)};
    state.dragCurrent = {x: snap(x), y: snap(y)};
    
    if (state.activeTool === 'sketch') {
      state.rawPoints = [state.dragStart];
    }
    
    elements.canvas.setPointerCapture(e.pointerId);
    
    log(`Drawing ${state.activeTool}...`, 'sys');
  }

  function onPointerMove(e) {
    if (!state.isDrawing) return;
    
    e.preventDefault();
    
    const rect = elements.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    state.dragCurrent = {x: snap(x), y: snap(y)};
    
    if (state.activeTool === 'sketch') {
      state.rawPoints.push({x: x, y: y});
    }
    
    render();
  }

  function onPointerUp(e) {
    if (!state.isDrawing) return;
    
    console.log("Pointer up! Creating shape...");
    
    state.isDrawing = false;
    
    if (state.activeTool === 'sketch') {
      recognizeSketch(state.rawPoints);
    } else {
      createShapeFromDrag();
    }
    
    state.rawPoints = [];
    
    if(elements.canvas.hasPointerCapture(e.pointerId)) {
      elements.canvas.releasePointerCapture(e.pointerId);
    }
  }

  function createShapeFromDrag() {
    const s = state.dragStart;
    const e = state.dragCurrent;
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    
    console.log("Creating shape:", state.activeTool, "from", s, "to", e);
    
    // Don't create shape if drag is too small
    if (Math.hypot(dx, dy) < 5) {
      log("Drag too small, try again", "err");
      return;
    }

    const obj = { 
        id: Date.now(), 
        type: state.activeTool, 
        params: {} 
    };
    
    // Handle each shape type
    if (state.activeTool === 'line') {
        obj.params = {x1: s.x, y1: s.y, x2: e.x, y2: e.y};
    } 
    else if (state.activeTool === 'rect') {
        obj.params = {
            x: Math.min(s.x, e.x), 
            y: Math.min(s.y, e.y), 
            w: Math.abs(dx), 
            h: Math.abs(dy)
        };
    } 
    else if (state.activeTool === 'circle') {
        obj.params = {
            cx: (s.x + e.x) / 2, 
            cy: (s.y + e.y) / 2, 
            radius: Math.hypot(dx, dy) / 2
        };
    } 
    else {
        // ALL OTHER SHAPES (polygons, stars) use center + radius
        const radius = Math.hypot(dx, dy);
        obj.params = { 
            cx: s.x, 
            cy: s.y, 
            radius: radius 
        };
    }
    
    console.log("Created object:", obj);
    addObject(obj);
  }

  function recognizeSketch(pts) {
    if (pts.length < 5) {
      log("Sketch too short", "err");
      return;
    }
    
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    pts.forEach(p => { 
      minX=Math.min(minX,p.x); 
      maxX=Math.max(maxX,p.x); 
      minY=Math.min(minY,p.y); 
      maxY=Math.max(maxY,p.y); 
    });
    
    const w=maxX-minX, h=maxY-minY;
    const gap = Math.hypot(
      pts[pts.length-1].x - pts[0].x, 
      pts[pts.length-1].y - pts[0].y
    );
    
    const obj = { id:Date.now(), type:'unknown', params:{} };

    if (gap > Math.hypot(w,h)*0.35) {
        obj.type='line'; 
        obj.params={
          x1:pts[0].x, 
          y1:pts[0].y, 
          x2:pts[pts.length-1].x, 
          y2:pts[pts.length-1].y
        };
    } else {
        const ratio = w>h ? h/w : w/h;
        if (ratio > 0.8) { 
          obj.type='circle'; 
          obj.params={
            cx:minX+w/2, 
            cy:minY+h/2, 
            radius:Math.max(w,h)/2
          }; 
        } else { 
          obj.type='rect'; 
          obj.params={x:minX, y:minY, w:w, h:h}; 
        }
    }
    
    addObject(obj);
  }

  function addObject(obj) {
    state.objects.push(obj);
    state.lastObjectId = obj.id;
    saveState();
    updateObjectDisplay(obj);
    render();
    log(`Created ${obj.type}`, 'sys');
  }

  function render() {
    if(!elements.ctx) return;
    
    const ctx = elements.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = elements.canvas.width / dpr;
    const h = elements.canvas.height / dpr;

    // Clear
    ctx.fillStyle = '#0f1115'; 
    ctx.fillRect(0, 0, w, h);
    
    // Grid
    drawGrid(w, h);

    // Draw existing objects
    const drawFunc = (state.mode === 'draw') ? 
        (obj) => drawShape(obj) : 
        (obj) => { ctx.globalAlpha=0.2; drawShape(obj); ctx.globalAlpha=1.0; };
    
    state.objects.forEach(drawFunc);

    // Draw preview while dragging
    if (state.isDrawing && state.activeTool !== 'sketch') {
        ctx.strokeStyle = '#3b82f6'; 
        ctx.lineWidth = 2;
        ctx.setLineDash([5,5]); 
        ctx.beginPath();
        
        const s = state.dragStart;
        const e = state.dragCurrent;
        
        if(state.activeTool === 'line') {
            ctx.moveTo(s.x, s.y); 
            ctx.lineTo(e.x, e.y);
        }
        else if(state.activeTool === 'rect') {
            ctx.rect(
              Math.min(s.x, e.x), 
              Math.min(s.y, e.y), 
              Math.abs(e.x - s.x), 
              Math.abs(e.y - s.y)
            );
        }
        else if(state.activeTool === 'circle') {
            ctx.arc(
              (s.x + e.x) / 2, 
              (s.y + e.y) / 2, 
              Math.hypot(e.x - s.x, e.y - s.y) / 2, 
              0, 
              Math.PI * 2
            );
        }
        else {
            // Handle all polygon shapes
            const r = Math.hypot(e.x - s.x, e.y - s.y);
            let sides = 3;
            let isStar = false;
            
            if(state.activeTool === 'triangle') sides = 3;
            else if(state.activeTool === 'pentagon') sides = 5;
            else if(state.activeTool === 'hexagon') sides = 6;
            else if(state.activeTool === 'octagon') sides = 8;
            else if(state.activeTool === 'decagon') sides = 10;
            else if(state.activeTool === 'star') { sides = 5; isStar = true; }
            else if(state.activeTool === 'burst') { sides = 8; isStar = true; }
            
            const pts = getPolygonVertices(s.x, s.y, r, sides, isStar);
            ctx.moveTo(pts[0].x, pts[0].y);
            pts.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.closePath();
        }
        
        ctx.stroke(); 
        ctx.setLineDash([]);
    }

    // Draw freehand sketch preview
    if (state.isDrawing && state.activeTool === 'sketch' && state.rawPoints.length > 1) {
        ctx.strokeStyle = '#3b82f6'; 
        ctx.lineWidth = 2; 
        ctx.beginPath();
        ctx.moveTo(state.rawPoints[0].x, state.rawPoints[0].y);
        for(let p of state.rawPoints) {
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
    }

    // Simulation mode
    if (state.mode === 'sim' && state.simPath.length > 1) {
        updateSim();
        
        for(let i=0; i<state.simIndex; i++) {
            const p1 = state.simPath[i]; 
            const p2 = state.simPath[i+1];
            
            ctx.beginPath(); 
            ctx.moveTo(p1.x, p1.y); 
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = p2.type==='cut' ? '#238636' : '#ef4444';
            ctx.lineWidth = p2.type==='cut' ? 2 : 0.5;
            if(p2.type!=='cut') ctx.setLineDash([5,5]);
            ctx.stroke(); 
            ctx.setLineDash([]);
        }

        if(state.simIndex < state.simPath.length - 1) {
            const start = state.simPath[state.simIndex];
            const end = state.simPath[state.simIndex+1];
            const curX = start.x + (end.x - start.x) * state.simProgress;
            const curY = start.y + (end.y - start.y) * state.simProgress;
            
            ctx.beginPath(); 
            ctx.moveTo(start.x, start.y); 
            ctx.lineTo(curX, curY);
            ctx.strokeStyle = end.type==='cut' ? '#238636' : '#ef4444';
            ctx.lineWidth = end.type==='cut' ? 2 : 0.5;
            if(end.type!=='cut') ctx.setLineDash([5,5]);
            ctx.stroke(); 
            ctx.setLineDash([]);
            
            ctx.fillStyle = '#fff'; 
            ctx.beginPath(); 
            ctx.arc(curX, curY, 4, 0, Math.PI*2); 
            ctx.fill();
        }
    }
  }

  function drawShape(obj) {
    const ctx = elements.ctx;
    ctx.beginPath();
    
    const isSel = (obj.id === state.lastObjectId);
    ctx.strokeStyle = isSel ? '#3b82f6' : '#e6edf3'; 
    ctx.lineWidth = isSel ? 3 : 2;
    
    const p = obj.params;
    
    if (obj.type==='line') { 
      ctx.moveTo(p.x1,p.y1); 
      ctx.lineTo(p.x2,p.y2); 
    }
    else if (obj.type==='rect') {
      ctx.rect(p.x,p.y,p.w,p.h);
    }
    else if (obj.type==='circle') {
      ctx.arc(p.cx,p.cy,p.radius,0,Math.PI*2);
    }
    else {
        let sides=3, isStar=false;
        
        if(obj.type==='triangle') sides=3;
        if(obj.type==='pentagon') sides=5;
        if(obj.type==='hexagon') sides=6;
        if(obj.type==='octagon') sides=8;
        if(obj.type==='decagon') sides=10;
        if(obj.type==='star') {sides=5; isStar=true;}
        if(obj.type==='burst') {sides=8; isStar=true;}
        
        const pts = getPolygonVertices(p.cx, p.cy, p.radius, sides, isStar);
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.forEach(pt => ctx.lineTo(pt.x, pt.y));
        ctx.closePath();
    }
    
    ctx.stroke();
  }

  function drawGrid(w, h) {
    const ctx = elements.ctx;
    ctx.strokeStyle = '#30363d'; 
    ctx.lineWidth = 0.5; 
    ctx.beginPath();
    
    for(let x=0; x<w; x+=50){
      ctx.moveTo(x,0);
      ctx.lineTo(x,h);
    }
    for(let y=0; y<h; y+=50){
      ctx.moveTo(0,y);
      ctx.lineTo(w,y);
    }
    
    ctx.stroke();
  }

  function initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById('micBtn');
    const txt = document.getElementById('micText');
    
    if(!SpeechRecognition) { 
      if(txt) txt.textContent="No Voice Support"; 
      if(btn) btn.disabled = true;
      log("Voice recognition not supported in this browser", "err");
      return; 
    }
    
    const recognition = new SpeechRecognition(); 
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    
    let isListening = false;
    
    if(btn) {
      btn.onclick = (e) => {
        e.preventDefault();
        
        if(isListening) {
          // Stop listening
          try {
            recognition.stop();
            isListening = false;
            btn.classList.remove('active');
            if(txt) txt.textContent = "Click to Speak";
            log("Stopped listening", "sys");
          } catch(err) {
            console.error("Stop error:", err);
          }
        } else {
          // Start listening
          try {
            recognition.start();
            isListening = true;
            btn.classList.add('active');
            if(txt) txt.textContent = "Listening...";
            if(elements.voiceToast) {
              elements.voiceToast.textContent = "Listening...";
              elements.voiceToast.style.opacity = 1;
            }
            log("Listening for voice command...", "sys");
          } catch(err) {
            console.error("Start error:", err);
            log("Could not start voice recognition", "err");
            isListening = false;
            btn.classList.remove('active');
            if(txt) txt.textContent = "Click to Speak";
          }
        }
      };
    }
    
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript.toLowerCase();
      const confidence = e.results[0][0].confidence;
      
      console.log("Voice heard:", transcript, "Confidence:", confidence);
      
      showToast(`"${transcript}"`);
      log(`Heard: "${transcript}" (${Math.round(confidence*100)}%)`, 'cmd');
      parseCommand(transcript);
      
      isListening = false;
      if(btn) btn.classList.remove('active');
      if(txt) txt.textContent = "Click to Speak";
    };
    
    recognition.onerror = (e) => {
      console.error("Voice recognition error:", e.error);
      
      isListening = false;
      if(btn) btn.classList.remove('active');
      if(txt) txt.textContent = "Click to Speak";
      if(elements.voiceToast) elements.voiceToast.style.opacity = 0;
      
      if(e.error === 'no-speech') {
        log("No speech detected. Try again.", "err");
      } else if(e.error === 'not-allowed') {
        log("Microphone access denied. Enable it in browser settings.", "err");
        if(txt) txt.textContent = "Mic Blocked";
      } else {
        log(`Voice error: ${e.error}`, "err");
      }
    };
    
    recognition.onend = () => {
      console.log("Recognition ended");
      isListening = false;
      if(btn) btn.classList.remove('active');
      if(txt) txt.textContent = "Click to Speak";
      if(elements.voiceToast) elements.voiceToast.style.opacity = 0;
    };
    
    log("Voice recognition ready. Click mic to speak.", "sys");
  }

  function textToNumber(str) {
    const map = {
      'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
      'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
      'eleven': 11, 'twelve': 12, 'fifteen': 15, 'twenty': 20, 
      'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60,
      'seventy': 70, 'eighty': 80, 'ninety': 90, 'hundred': 100
    };
    
    // Try to extract number directly
    const numMatch = str.match(/(\d+(\.\d+)?)/);
    if(numMatch) return parseFloat(numMatch[0]);
    
    // Try word mapping
    for(let word in map) {
      if(str.includes(word)) return map[word];
    }
    
    return null;
  }

  function parseCommand(cmd) {
    console.log("Parsing command:", cmd);
    
    const val = textToNumber(cmd);
    console.log("Extracted value:", val);
    
    // Clear/Reset commands
    if(cmd.includes('clear') || cmd.includes('reset') || cmd.includes('delete all')) {
      clearCanvas();
      showToast("Canvas cleared!");
      return;
    }
    
    // Undo command
    if(cmd.includes('undo')) {
      undo();
      showToast("Undone!");
      return;
    }
    
    // Depth command
    if(cmd.includes('depth') && val !== null) {
      let mult = 1;
      if(cmd.includes('cm') || cmd.includes('centimeter')) mult = 10;
      if(cmd.includes('inch')) mult = 25.4;
      
      const num = val * mult;
      state.globalDepth = num;
      
      const depthEl = document.getElementById('dispDepth');
      if(depthEl) depthEl.textContent = num.toFixed(1) + " mm";
      
      log(`Depth set to ${num.toFixed(1)} mm`, 'sys');
      showToast(`Depth: ${num.toFixed(1)} mm`);
      return;
    }
    
    // If no value extracted and not a special command, exit
    if(val === null) {
      log("Command not understood. Try: 'width 50', 'depth 5', 'clear'", "err");
      showToast("Command not understood");
      return;
    }
    
    // Get last selected object
    const obj = state.objects.find(o => o.id === state.lastObjectId);
    if(!obj) {
      log("No shape selected. Draw a shape first.", "err");
      showToast("Draw a shape first");
      return;
    }
    
    // Determine units
    let mult = 1;
    if(cmd.includes('cm') || cmd.includes('centimeter')) mult = 10;
    if(cmd.includes('inch')) mult = 25.4;
    
    const num = val * mult;
    let modified = false;
    let whatChanged = "";
    
    // Modify rectangle dimensions
    if(obj.type === 'rect') {
      if(cmd.includes('width') || cmd.includes('length') || cmd.includes('horizontal')) {
        obj.params.w = num;
        modified = true;
        whatChanged = `width to ${Math.round(num)}`;
      }
      if(cmd.includes('height') || cmd.includes('tall') || cmd.includes('vertical')) {
        obj.params.h = num;
        modified = true;
        whatChanged = `height to ${Math.round(num)}`;
      }
    }
    
    // Modify circle/polygon radius
    if(obj.type === 'circle' || obj.type.includes('gon') || obj.type === 'star' || obj.type === 'burst') {
      if(cmd.includes('radius') || cmd.includes('size') || cmd.includes('diameter')) {
        if(cmd.includes('diameter')) {
          obj.params.radius = num / 2;
          whatChanged = `diameter to ${Math.round(num)}`;
        } else {
          obj.params.radius = num;
          whatChanged = `radius to ${Math.round(num)}`;
        }
        modified = true;
      }
    }
    
    if(modified) {
      saveState();
      updateObjectDisplay(obj);
      render();
      log(`Updated ${whatChanged}`, 'sys');
      showToast(`Set ${whatChanged}`);
    } else {
      log("Command not applied. Try: 'width 50', 'height 30', 'radius 25'", "err");
      showToast("Try: width/height/radius + number");
    }
  }

  function generateGCode() {
    if (state.objects.length === 0) {
      log("Empty canvas.", "err");
      return;
    }
    
    let c = [
      "%", 
      "(Sketch2Code Export)", 
      `(Depth: ${state.globalDepth}mm)`, 
      "G21 G90 G17", 
      "G0 Z5", 
      "M3 S12000"
    ];
    
    const d = state.globalDepth;
    const f = n => n.toFixed(3);
    let totalDist = 0;

    state.objects.forEach((obj, i) => {
      c.push(`(Shape ${i+1}: ${obj.type})`);
      const p = obj.params;
      
      if (obj.type === 'line') {
         c.push(`G0 X${f(p.x1)} Y${f(p.y1)}`);
         c.push(`G1 Z-${d} F200`);
         c.push(`G1 X${f(p.x2)} Y${f(p.y2)} F800`);
         totalDist += Math.hypot(p.x2-p.x1, p.y2-p.y1);
      } 
      else if (obj.type === 'rect') {
         c.push(`G0 X${f(p.x)} Y${f(p.y)}`);
         c.push(`G1 Z-${d} F200`);
         c.push(`G1 X${f(p.x+p.w)} Y${f(p.y)} F800`);
         c.push(`G1 X${f(p.x+p.w)} Y${f(p.y+p.h)}`);
         c.push(`G1 X${f(p.x)} Y${f(p.y+p.h)}`);
         c.push(`G1 X${f(p.x)} Y${f(p.y)}`);
         totalDist += (p.w+p.h)*2;
      } 
      else if (obj.type === 'circle') {
         c.push(`G0 X${f(p.cx+p.radius)} Y${f(p.cy)}`);
         c.push(`G1 Z-${d} F200`);
         c.push(`G3 X${f(p.cx+p.radius)} Y${f(p.cy)} I-${f(p.radius)} J0 F800`);
         totalDist += 2 * Math.PI * p.radius;
      } 
      else {
         let sides=3; 
         let isStar=false;
         
         if(obj.type==='triangle') sides=3;
         if(obj.type==='pentagon') sides=5;
         if(obj.type==='hexagon') sides=6;
         if(obj.type==='octagon') sides=8;
         if(obj.type==='decagon') sides=10;
         if(obj.type==='star') {sides=5; isStar=true;}
         if(obj.type==='burst') {sides=8; isStar=true;}

         const pts = getPolygonVertices(p.cx, p.cy, p.radius, sides, isStar);
         c.push(`G0 X${f(pts[0].x)} Y${f(pts[0].y)}`);
         c.push(`G1 Z-${d} F200`);
         
         for(let k=1; k<pts.length; k++) {
             c.push(`G1 X${f(pts[k].x)} Y${f(pts[k].y)} F800`);
             totalDist += Math.hypot(pts[k].x-pts[k-1].x, pts[k].y-pts[k-1].y);
         }
         c.push(`G1 X${f(pts[0].x)} Y${f(pts[0].y)}`); 
         totalDist += Math.hypot(pts[0].x-pts[pts.length-1].x, pts[0].y-pts[pts.length-1].y);
      }
      c.push("G0 Z5");
    });
    
    c.push("M5", "M30", "%");

    const timeSec = (totalDist / 800) * 60;
    log(`Est. Cycle Time: ${timeSec.toFixed(1)} sec`, 'sys');

    const blob = new Blob([c.join('\n')], {type:'text/plain'});
    const link = document.createElement('a'); 
    link.href = URL.createObjectURL(blob); 
    link.download = 'sketch2code.nc'; 
    link.click();
    log("G-Code Exported.", "sys");
  }

  function log(m, t) { 
    if(!elements.consoleLog) return;
    const d=document.createElement('div');
    d.className='log-item';
    d.innerHTML=`<span class="log-${t}">${m}</span>`;
    elements.consoleLog.prepend(d); 
  }
  
  function showToast(m) { 
    if(!elements.voiceToast) return;
    elements.voiceToast.textContent=m; 
    elements.voiceToast.style.opacity=1; 
    setTimeout(()=>elements.voiceToast.style.opacity=0,2000); 
  }
  
  function clearCanvas() { 
    state.objects=[]; 
    state.lastObjectId=null; 
    saveState(); 
    render(); 
    log("Cleared.", 'sys'); 
  }
  
  function updateObjectDisplay(obj) {
     const typeEl = document.getElementById('dispType');
     const dimEl = document.getElementById('dispDim');
     
     if(typeEl) typeEl.textContent=obj.type.toUpperCase();
     
     if(dimEl) {
       if(obj.type==='circle' || obj.type.includes('gon') || obj.type==='star' || obj.type==='burst') {
         dimEl.textContent=`R:${Math.round(obj.params.radius)}`;
       }
       else if(obj.type==='line') {
         dimEl.textContent=`L:${Math.round(Math.hypot(obj.params.x2-obj.params.x1,obj.params.y2-obj.params.y1))}`;
       }
       else if(obj.params.w && obj.params.h) {
         dimEl.textContent=`${Math.round(obj.params.w)}x${Math.round(obj.params.h)}`;
       }
     }
  }
  
  function loop() { 
    if(state.mode==='sim') render(); 
    requestAnimationFrame(loop); 
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);