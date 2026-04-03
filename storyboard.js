window.showStoryboard = function() {
    let m = document.getElementById('storyboard-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'storyboard-modal';
        m.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15,23,42,0.98); z-index:10000; display:flex; flex-direction:column;";

        let header = document.createElement('div');
        header.style.cssText = "padding:15px 20px; background:#1e293b; color:white; display:flex; justify-content:space-between; align-items:center; box-shadow:0 4px 15px rgba(0,0,0,0.5); z-index:2;";
        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:15px;">
                <h2 style="margin:0; font-size:1.2rem; display:flex; align-items:center; gap:10px;">🗺️ Story Flowchart</h2>
                <span style="font-size:0.8rem; color:#94a3b8; background:#334155; padding:4px 10px; border-radius:15px;">Scroll to Zoom • Drag to Pan</span>
            </div>
            <button onclick="document.getElementById('storyboard-modal').style.display='none'" style="background:#ef4444; color:white; border:none; padding:8px 18px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.9rem;">Close</button>
        `;
        m.appendChild(header);

        let content = document.createElement('div');
        content.id = 'storyboard-content';
        content.style.cssText = "flex:1; overflow:hidden; position:relative; width:100%; height:100%;";
        m.appendChild(content);

        document.body.appendChild(m);
    }
    m.style.display = 'flex';

    const content = document.getElementById('storyboard-content');
    content.innerHTML = `<div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:#cbd5e1; font-family:monospace; font-size:1.1rem; display:flex; flex-direction:column; align-items:center; gap:10px;">
        <div style="width:30px; height:30px; border:3px solid #cbd5e1; border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite;"></div>
        Generating flowchart...
    </div>
    <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>`;

    let defs = ["graph TD"];

    let groupedBlocks = {};
    story.blocks.forEach(b => {
        let g = b.group || 'Ungrouped';
        if (!groupedBlocks[g]) groupedBlocks[g] = [];
        groupedBlocks[g].push(b);
    });

    Object.keys(groupedBlocks).forEach((g, i) => {
        let cleanG = g.replace(/[^a-zA-Z0-9]/g, '_');
        defs.push(`    subgraph ${cleanG} [${g}]`);
        groupedBlocks[g].forEach(b => {
            let cleanId = b.id.replace(/[^a-zA-Z0-9_]/g, '_');
            let label = b.id.length > 25 ? b.id.substring(0, 25) + '...' : b.id;
            label = label.replace(/"/g, "'");
            defs.push(`        ${cleanId}("${label}")`);
        });
        defs.push(`    end`);
    });

    story.blocks.forEach(b => {
        let cleanId = b.id.replace(/[^a-zA-Z0-9_]/g, '_');
        (b.choices || []).forEach(c => {
            if (c.next) {
                let cleanNext = c.next.replace(/[^a-zA-Z0-9_]/g, '_');
                let edgeLabel = c.txt ? (c.txt.length > 20 ? c.txt.substring(0, 20) + '...' : c.txt) : '';
                edgeLabel = edgeLabel.replace(/"/g, "'").trim();
                if (edgeLabel) {
                    defs.push(`    ${cleanId} -->|"${edgeLabel}"| ${cleanNext}`);
                } else {
                    defs.push(`    ${cleanId} --> ${cleanNext}`);
                }
            }
        });
    });

    defs.push("    classDef default fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc,rx:8,ry:8;");
    defs.push("    style Ungrouped fill:none,stroke:none;");

    let mmString = defs.join("\n");

    const loadPanZoom = () => {
        if (window.svgPanZoom) return Promise.resolve();
        return new Promise((res) => {
            const script = document.createElement('script');
            script.src = "https://cdn.jsdelivr.net/npm/svg-pan-zoom@3.6.1/dist/svg-pan-zoom.min.js";
            script.onload = res;
            document.head.appendChild(script);
        });
    };

    const loadMermaid = () => {
        if (window.mermaid) return Promise.resolve();
        return new Promise((res) => {
            const script = document.createElement('script');
            script.src = "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js";
            script.onload = () => {
                mermaid.initialize({ 
                    startOnLoad: false, 
                    theme: 'dark', 
                    maxTextSize: 90000,
                    flowchart: { useMaxWidth: false, rankSpacing: 80, nodeSpacing: 60 }
                });
                res();
            };
            document.head.appendChild(script);
        });
    };

    Promise.all([loadMermaid(), loadPanZoom()]).then(() => {
        mermaid.render('storyboard-svg-' + Date.now(), mmString).then(({svg}) => {
            content.innerHTML = svg;
            let svgEl = content.querySelector('svg');
            svgEl.style.width = '100%';
            svgEl.style.height = '100%';
            svgEl.style.maxWidth = 'none';

            // Wait for DOM to register the SVG sizes
            setTimeout(() => {
                window.myPanZoom = svgPanZoom(svgEl, {
                    zoomEnabled: true,
                    controlIconsEnabled: true,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 5,
                    zoomScaleSensitivity: 0.2
                });

                // Force a sensible default scale so it's not totally zoomed out for large graphs
                let currentZoom = window.myPanZoom.getZoom();
                if(currentZoom < 0.7) {
                     window.myPanZoom.zoom(0.8);
                     window.myPanZoom.center();
                }
            }, 100);

        }).catch(err => {
            content.innerHTML = `<div style="color:#ef4444; background:#fee2e2; padding:15px; border-radius:6px; font-family:monospace; margin:20px;">Error rendering flowchart. Story might be too complex or contain invalid characters.<br><br>${err.message}</div>`;
        });
    });
};;