// Chart Drawing Tools System

class ChartTools {
    constructor(chartManager) {
        this.chartManager = chartManager;
        this.currentTool = 'cursor';
        this.isDrawing = false;
        this.drawings = [];
        this.currentDrawing = null;
        this.brushPoints = [];
        this.undoStack = [];
        this.redoStack = [];
        this.toolHotkeys = {
            cursor: 'Escape',
            line: 'KeyL',
            horizontal: 'KeyH',
            brush: 'KeyB',
            rectangle: 'KeyR',
            fib: 'KeyF',
        };
        this.brushColor = '#4cc9f0';
        this.brushWidth = 4;
        
        // Setup event listeners
        this.setupToolbar();
        this.setupChartInteraction();
        this.setupKeyboardShortcuts();
    }

    setupToolbar() {
        // Timeframe buttons
        document.querySelectorAll('.timeframe-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const timeframe = btn.dataset.tf;
                this.changeTimeframe(timeframe);
            });
        });

        // Tool buttons
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.currentTool = btn.dataset.tool;
                this.updateCursor();
            });
        });

        // Brush color palette
        const colorPalette = document.getElementById('brush-color-palette');
        if (colorPalette) {
            colorPalette.querySelectorAll('.brush-color-swatch').forEach(btn => {
                // Set background color from data-color attribute
                const color = btn.dataset.color;
                if (color) {
                    btn.style.background = color;
                }
                
                btn.addEventListener('click', () => {
                    const color = btn.dataset.color;
                    if (!color) return;
                    this.brushColor = color;

                    // Update active state
                    colorPalette.querySelectorAll('.brush-color-swatch').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
        }

        // Brush size palette
        const sizePalette = document.getElementById('brush-size-palette');
        if (sizePalette) {
            sizePalette.querySelectorAll('.brush-size-dot').forEach(btn => {
                btn.addEventListener('click', () => {
                    const size = parseFloat(btn.dataset.size);
                    if (!size || size <= 0) return;
                    this.brushWidth = size;

                    // Update active state
                    sizePalette.querySelectorAll('.brush-size-dot').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });
        }

        // Clear drawings
        document.getElementById('clear-drawings')?.addEventListener('click', () => {
            this.clearAllDrawings();
        });

        // Undo / Redo buttons
        document.getElementById('undo-drawing')?.addEventListener('click', () => {
            this.undo();
        });
        document.getElementById('redo-drawing')?.addEventListener('click', () => {
            this.redo();
        });

        // Indicator selector
        document.getElementById('indicator-selector')?.addEventListener('change', (e) => {
            if (e.target.value) {
                this.addIndicator(e.target.value);
                e.target.value = '';
            }
        });
    }

    setupChartInteraction() {
        const chartContainer = this.chartManager.container;
        
        // ⚡ LINE DRAGGING STATE
        this.isDraggingLine = false;
        this.draggedLineType = null; // 'sl' or 'tp'
        this.dragStartY = null;
        
        chartContainer.addEventListener('mousedown', (e) => {
            // Check if dragging is enabled and we're near a line
            const dragEnabled = this.isLineDragEnabled();
            if (dragEnabled && this.currentTool === 'cursor') {
                const nearLine = this.checkNearLine(e);
                if (nearLine) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.startDraggingLine(nearLine, e);
                    return;
                }
            }
            
            if (this.currentTool !== 'cursor') {
                e.preventDefault(); // Prevent chart panning
                e.stopPropagation();
            }
            this.onMouseDown(e);
        }, true); // Use capture phase
        
        chartContainer.addEventListener('mousemove', (e) => {
            // Handle line dragging
            if (this.isDraggingLine) {
                e.preventDefault();
                e.stopPropagation();
                this.onDragLine(e);
                return;
            }
            
            if (this.isDrawing && this.currentTool !== 'cursor') {
                e.preventDefault();
                e.stopPropagation();
            }
            this.onMouseMove(e);
        }, true);
        
        chartContainer.addEventListener('mouseup', (e) => {
            // Stop line dragging
            if (this.isDraggingLine) {
                e.preventDefault();
                e.stopPropagation();
                this.stopDraggingLine(e);
                return;
            }
            
            if (this.currentTool !== 'cursor') {
                e.preventDefault();
                e.stopPropagation();
            }
            this.onMouseUp(e);
        }, true);
        
        chartContainer.addEventListener('dblclick', (e) => {
            // Check if double-click mode is disabled (drag mode enabled)
            if (this.isLineDragEnabled()) {
                // Double-click disabled - drag mode active
                return;
            }
            this.onDoubleClick(e);
        });
        
        // ✅ NEW: Right-click double-click for TP
        chartContainer.addEventListener('contextmenu', (e) => {
            // Prevent default context menu
            e.preventDefault();
            e.stopPropagation();
            return false;
        });
        
        // Track right-click double-clicks manually
        this.lastRightClickTime = 0;
        chartContainer.addEventListener('mousedown', (e) => {
            if (e.button === 2) { // Right click
                const now = Date.now();
                if (now - this.lastRightClickTime < 300) {
                    // Double right-click detected!
                    if (!this.isLineDragEnabled()) {
                        this.onDoubleRightClick(e);
                    }
                }
                this.lastRightClickTime = now;
            }
        });
        
        // Subscribe to chart updates (pan/zoom/scroll) to redraw drawings
        this.chartManager.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
            this.redrawCanvas();
        });
        
        this.chartManager.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            this.redrawCanvas();
        });
        
        // Redraw on window resize
        window.addEventListener('resize', () => {
            this.redrawCanvas();
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Global tool hotkeys (ignore if typing in inputs)
            if (!e.target.matches('input, textarea, select')) {
                const toolFromHotkey = this.getToolForKeyEvent(e);
                if (toolFromHotkey) {
                    e.preventDefault();
                    this.selectTool(toolFromHotkey);
                    return;
                }
            }

            switch(e.key.toLowerCase()) {
                case 'escape':
                    this.selectTool('cursor');
                    break;
                case 'z':
                    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        this.undo();
                    }
                    break;
                case 'y':
                    if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        this.redo();
                    }
                    break;
                case 'delete':
                case 'backspace':
                    if (!e.target.matches('input, textarea')) this.deleteSelectedDrawing();
                    break;
            }
        });

        // Mouse-button-based tool switching (for side buttons, etc.)
        document.addEventListener('mousedown', (e) => {
            // Don't interfere when editing inputs/selects (e.g., in settings modal)
            if (e.target.matches('input, textarea, select')) return;

            const toolFromMouse = this.getToolForMouseEvent(e);
            if (!toolFromMouse) return;

            // Prevent browser Back/Forward for Mouse4/Mouse5
            if (e.button === 3 || e.button === 4) {
                e.preventDefault();
                e.stopPropagation();
            }

            this.selectTool(toolFromMouse);
        }, true);

        // Listen for hotkey mapping updates from app.js
        document.addEventListener('tool-hotkeys-updated', (e) => {
            if (e.detail && e.detail.hotkeys) {
                this.applyHotkeyConfig(e.detail.hotkeys);
            }
        });

        // Initial load from localStorage via custom event fired on init (optional)
        try {
            const saved = localStorage.getItem('toolHotkeys');
            if (saved) {
                this.applyHotkeyConfig(JSON.parse(saved));
            }
        } catch (err) {
            console.error('Failed to load toolHotkeys in ChartTools', err);
        }
    }

    applyHotkeyConfig(hotkeys) {
        // Normalize: store as codes (e.g., 'KeyL', 'Escape')
        const map = { ...this.toolHotkeys };
        Object.entries(hotkeys).forEach(([tool, code]) => {
            if (!map.hasOwnProperty(tool)) return;
            // If user saved just a single letter like "L", convert to KeyL
            if (code.length === 1 && /[a-z]/i.test(code)) {
                map[tool] = 'Key' + code.toUpperCase();
            } else {
                map[tool] = code;
            }
        });
        this.toolHotkeys = map;
    }

    getToolForKeyEvent(e) {
        const code = e.code || e.key;
        if (!code) return null;
        // Match against configured codes
        return Object.keys(this.toolHotkeys).find(
            tool => this.toolHotkeys[tool] === code
        ) || null;
    }

    getToolForMouseEvent(e) {
        const code = this.mouseCodeFromButton(e.button);
        if (!code) return null;
        return Object.keys(this.toolHotkeys).find(
            tool => this.toolHotkeys[tool] === code
        ) || null;
    }

    mouseCodeFromButton(button) {
        if (button === 3) return 'Mouse4';
        if (button === 4) return 'Mouse5';
        if (button === 1) return 'MouseMiddle';
        if (button === 2) return 'MouseRight';
        return null;
    }

    selectTool(tool) {
        document.querySelectorAll('.tool-btn').forEach(btn => {
            if (btn.dataset.tool === tool) {
                btn.classList.add('active');
                this.currentTool = tool;
            } else {
                btn.classList.remove('active');
            }
        });
        this.updateCursor();
        this.updateChartInteraction();
    }

    updateChartInteraction() {
        // Disable chart panning/zooming when using drawing tools
        if (this.currentTool !== 'cursor') {
            // Disable chart interactions
            this.chartManager.chart.applyOptions({
                handleScroll: false,
                handleScale: false,
            });
            
            // Add visual indicator
            this.chartManager.container.style.outline = '2px solid rgba(77, 201, 240, 0.5)';
        } else {
            // Re-enable chart interactions
            this.chartManager.chart.applyOptions({
                handleScroll: {
                    mouseWheel: true,
                    pressedMouseMove: true,
                },
                handleScale: {
                    axisPressedMouseMove: true,
                    mouseWheel: true,
                    pinch: true,
                },
            });
            
            // Remove visual indicator
            this.chartManager.container.style.outline = 'none';
        }
    }

    updateCursor() {
        const chartContainer = this.chartManager.container;
        switch(this.currentTool) {
            case 'cursor':
                chartContainer.style.cursor = 'default';
                break;
            case 'line':
            case 'horizontal':
            case 'rectangle':
            case 'fib':
                chartContainer.style.cursor = 'crosshair';
                break;
            case 'brush':
                chartContainer.style.cursor = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\'><circle cx=\'8\' cy=\'8\' r=\'4\' fill=\'rgba(77,201,240,0.5)\'/></svg>") 8 8, auto';
                break;
        }
    }

    onMouseDown(e) {
        if (this.currentTool === 'cursor') return;
        
        // Prevent any default behavior
        e.preventDefault();
        e.stopPropagation();
        
        const rect = this.chartManager.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        this.isDrawing = true;

        if (this.currentTool === 'brush') {
            // Hybrid: draw in pixel space for smooth freehand feel,
            // but also store a chart anchor + initial scale so the whole
            // stroke moves AND scales with the chart when you pan/zoom.
            const chartCoords = this.pixelToChartCoords(x, y);
            const anchorPx = this.chartToPixelCoords(chartCoords.time, chartCoords.price);

            // Sample how many pixels correspond to +1 logical step (time)
            const logical2 = chartCoords.time + 1;
            const pxLogical2 = this.chartToPixelCoords(logical2, chartCoords.price);

            const pxPerLogical0 = Math.abs((pxLogical2.x || 0) - (anchorPx.x || 0)) || 1;

            const anchorX = anchorPx.x || x;
            const anchorY = anchorPx.y || y;

            this.currentDrawing = {
                type: this.currentTool,
                points: [],
                color: this.brushColor,
                width: this.brushWidth,
                anchorTime: chartCoords.time,
                anchorPrice: chartCoords.price,
                anchorX,
                anchorY,
                pxPerLogical0
            };
            this.brushPoints = [{ x: anchorX, y: anchorY, dx: 0, dPrice: 0 }];
            this.currentDrawing.points = [...this.brushPoints];
        } else {
            // Convert pixel coordinates to chart coordinates (time, price)
            const chartCoords = this.pixelToChartCoords(x, y);
            
            this.currentDrawing = {
                type: this.currentTool,
                startTime: chartCoords.time,
                startPrice: chartCoords.price,
                endTime: chartCoords.time,
                endPrice: chartCoords.price,
                color: '#4cc9f0',
                width: 2
            };
        }
    }
    
    // Convert pixel coordinates to chart coordinates (time, price/logical)
    pixelToChartCoords(x, y) {
        const chart = this.chartManager.chart;
        const series = this.chartManager.candleSeries;
        
        if (!chart || !series) return { time: 0, price: 0 };
        
        // Use logical index instead of real time so we can draw
        // past the last candle and still keep shapes attached when panning.
        const logical = chart.timeScale().coordinateToLogical(x);
        
        // Convert y (pixels) to price
        const price = series.coordinateToPrice(y);
        
        return { time: logical || 0, price: price || 0 };
    }
    
    // Convert chart coordinates (time/logical, price) to pixel coordinates
    chartToPixelCoords(time, price) {
        const chart = this.chartManager.chart;
        const series = this.chartManager.candleSeries;
        
        if (!chart || !series) return { x: 0, y: 0 };
        
        // Convert logical/time to x (pixels)
        const x = chart.timeScale().logicalToCoordinate(time);
        
        // Convert price to y (pixels)
        const y = series.priceToCoordinate(price);
        
        return { x: x || 0, y: y || 0 };
    }

    onMouseMove(e) {
        if (!this.isDrawing) return;

        // Prevent chart from responding
        e.preventDefault();
        e.stopPropagation();

        const rect = this.chartManager.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        if (this.currentTool === 'brush') {
            // For brush strokes, track:
            // - horizontal offset in pixels (dx) for freehand feel
            // - vertical offset in price (dPrice) so strokes stay pinned
            //   to the same price levels when you scroll/zoom vertically.
            const chartCoords = this.pixelToChartCoords(x, y);
            const anchorPrice = this.currentDrawing.anchorPrice ?? chartCoords.price;
            const anchorX = this.currentDrawing.anchorX ?? x;

            const dx = x - anchorX;
            const dPrice = chartCoords.price - anchorPrice;

            this.brushPoints.push({ x, y, dx, dPrice });
            this.currentDrawing.points = [...this.brushPoints];
        } else {
            // Convert to chart coordinates for chart-anchored shapes
            const chartCoords = this.pixelToChartCoords(x, y);
            this.currentDrawing.endTime = chartCoords.time;
            this.currentDrawing.endPrice = chartCoords.price;
        }

        this.redrawCanvas();
    }

    onMouseUp(e) {
        if (!this.isDrawing) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        this.isDrawing = false;
        
        if (this.currentDrawing) {
            // Save state before adding new drawing for undo
            this.pushUndoState();
            this.drawings.push({...this.currentDrawing});
            this.currentDrawing = null;
            this.brushPoints = [];
        }

        this.redrawCanvas();
    }

    onDoubleClick(e) {
        // When in cursor mode, use double LEFT-click to set a manual stop-loss level
        if (this.currentTool !== 'cursor') return;

        const rect = this.chartManager.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const chartCoords = this.pixelToChartCoords(x, y);
        if (!chartCoords || !chartCoords.price) return;

        // NO SNAPPING - Use exact price from click coordinates
        // Trojan/trailing feature requires precision placement
        const event = new CustomEvent('manual-stop-change', { detail: { price: chartCoords.price } });
        document.dispatchEvent(event);
    }
    
    // ✅ NEW: Double RIGHT-click to move TP line
    onDoubleRightClick(e) {
        if (this.currentTool !== 'cursor') return;

        const rect = this.chartManager.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const chartCoords = this.pixelToChartCoords(x, y);
        if (!chartCoords || !chartCoords.price) return;

        // Dispatch TP change event
        const event = new CustomEvent('manual-tp-change', { detail: { price: chartCoords.price } });
        document.dispatchEvent(event);
        
        console.log(`🎯 TP placed at $${chartCoords.price.toFixed(2)} (via double right-click)`);
    }
    
    // ✅ NEW: Check if line drag mode is enabled
    isLineDragEnabled() {
        try {
            const saved = localStorage.getItem('lineDragEnabled');
            return saved === 'true';
        } catch (e) {
            return false;
        }
    }
    
    // ✅ NEW: Check if mouse is near SL or TP line
    checkNearLine(e) {
        const rect = this.chartManager.container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const series = this.chartManager.candleSeries;
        
        if (!series) return null;
        
        const clickPrice = series.coordinateToPrice(y);
        if (!clickPrice) return null;
        
        const threshold = 0.5; // $0.50 tolerance
        
        // Check SL line
        const slPrice = this.chartManager.stopPrice;
        if (slPrice && Math.abs(clickPrice - slPrice) < threshold) {
            return 'sl';
        }
        
        // Check TP line
        const tpPrice = this.chartManager.tpPrice;
        if (tpPrice && Math.abs(clickPrice - tpPrice) < threshold) {
            return 'tp';
        }
        
        return null;
    }
    
    // ✅ NEW: Start dragging a line
    startDraggingLine(lineType, e) {
        this.isDraggingLine = true;
        this.draggedLineType = lineType;
        
        const rect = this.chartManager.container.getBoundingClientRect();
        this.dragStartY = e.clientY - rect.top;
        
        // Visual feedback
        this.chartManager.container.style.cursor = 'ns-resize';
        
        console.log(`🔄 Started dragging ${lineType.toUpperCase()} line`);
    }
    
    // ✅ NEW: Handle line dragging
    onDragLine(e) {
        if (!this.isDraggingLine || !this.draggedLineType) return;
        
        const rect = this.chartManager.container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const series = this.chartManager.candleSeries;
        
        if (!series) return;
        
        const newPrice = series.coordinateToPrice(y);
        if (!newPrice || !isFinite(newPrice) || newPrice <= 0) return;
        
        // Update the line in real-time
        if (this.draggedLineType === 'sl') {
            this.chartManager.setStopLoss(newPrice);
        } else if (this.draggedLineType === 'tp') {
            this.chartManager.setTakeProfit(newPrice);
        }
    }
    
    // ✅ NEW: Stop dragging line
    stopDraggingLine(e) {
        if (!this.isDraggingLine || !this.draggedLineType) return;
        
        const rect = this.chartManager.container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const series = this.chartManager.candleSeries;
        
        if (series) {
            const finalPrice = series.coordinateToPrice(y);
            if (finalPrice && isFinite(finalPrice) && finalPrice > 0) {
                // Dispatch final update event
                if (this.draggedLineType === 'sl') {
                    const event = new CustomEvent('manual-stop-change', { detail: { price: finalPrice } });
                    document.dispatchEvent(event);
                    console.log(`✅ SL line moved to $${finalPrice.toFixed(2)} (via drag)`);
                } else if (this.draggedLineType === 'tp') {
                    const event = new CustomEvent('manual-tp-change', { detail: { price: finalPrice } });
                    document.dispatchEvent(event);
                    console.log(`✅ TP line moved to $${finalPrice.toFixed(2)} (via drag)`);
                }
            }
        }
        
        // Reset state
        this.isDraggingLine = false;
        this.draggedLineType = null;
        this.dragStartY = null;
        this.chartManager.container.style.cursor = 'default';
    }

    redrawCanvas() {
        // Get or create overlay canvas
        let canvas = document.getElementById('drawing-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = 'drawing-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '10';
            this.chartManager.container.style.position = 'relative';
            this.chartManager.container.appendChild(canvas);
        }

        const rect = this.chartManager.container.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw all saved drawings
        this.drawings.forEach(drawing => this.drawShape(ctx, drawing));

        // Draw current drawing
        if (this.currentDrawing) {
            this.drawShape(ctx, this.currentDrawing);
        }
    }

    drawShape(ctx, drawing) {
        ctx.strokeStyle = drawing.color;
        ctx.lineWidth = drawing.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Convert chart coordinates back to pixel coordinates
        const start = this.chartToPixelCoords(drawing.startTime, drawing.startPrice);
        const end = this.chartToPixelCoords(drawing.endTime, drawing.endPrice);

        switch(drawing.type) {
            case 'line':
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
                break;

            case 'horizontal':
                ctx.beginPath();
                ctx.moveTo(0, start.y);
                ctx.lineTo(ctx.canvas.width, start.y);
                ctx.setLineDash([5, 5]);
                ctx.stroke();
                ctx.setLineDash([]);
                break;

            case 'rectangle':
                ctx.strokeRect(
                    start.x,
                    start.y,
                    end.x - start.x,
                    end.y - start.y
                );
                break;

            case 'brush':
                if (drawing.points && drawing.points.length > 1) {
                    const rawPoints = drawing.points;

                    // Support both old (chart-based) and new (pixel/price-offset) brush data:
                    // - Old: { time, price } → convert via chartToPixelCoords
                    // - New: { x, y, dx, dPrice } plus anchorTime/anchorPrice/anchorX and initial scale
                    let pixelPoints;
                    if ('x' in rawPoints[0] && 'y' in rawPoints[0]) {
                        // New pixel/price-offset strokes: move & scale by how much the chart changed
                        const anchorTime = drawing.anchorTime;
                        const anchorPrice = drawing.anchorPrice;
                        const anchorX = drawing.anchorX;
                        const pxPerLogical0 = drawing.pxPerLogical0;

                        if (anchorTime != null && anchorPrice != null &&
                            typeof anchorX === 'number' &&
                            pxPerLogical0) {
                            const anchorNow = this.chartToPixelCoords(anchorTime, anchorPrice);
                            const logical2 = anchorTime + 1;
                            const pxLogical2 = this.chartToPixelCoords(logical2, anchorPrice);

                            const pxPerLogicalNow = Math.abs((pxLogical2.x || 0) - (anchorNow.x || 0)) || pxPerLogical0;
                            const sx = pxPerLogicalNow / pxPerLogical0;

                            const series = this.chartManager.candleSeries;

                            pixelPoints = rawPoints.map(p => {
                                const x = anchorNow.x + (p.dx ?? (p.x - anchorX)) * sx;

                                // If we stored a price offset, use it so vertical motion
                                // stays glued to the same price levels when scrolling/zooming.
                                if (typeof p.dPrice === 'number' && series) {
                                    const priceAtPoint = anchorPrice + p.dPrice;
                                    const y = series.priceToCoordinate(priceAtPoint);
                                    return { x, y: y ?? anchorNow.y };
                                }

                                // Fallback: just translate Y like before
                                const dy = (p.y - (drawing.anchorY ?? anchorNow.y));
                                return { x, y: anchorNow.y + dy };
                            });
                        } else {
                            // Fallback: draw where they were recorded
                            pixelPoints = rawPoints;
                        }
                    } else {
                        pixelPoints = rawPoints
                            .map(p => this.chartToPixelCoords(p.time, p.price))
                            .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
                    }

                    if (pixelPoints.length > 1) {
                        ctx.beginPath();

                        // For very short strokes, just draw a simple line
                        if (pixelPoints.length < 3) {
                            ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
                            ctx.lineTo(pixelPoints[1].x, pixelPoints[1].y);
                        } else {
                            // Draw a smooth curve through the points using quadratic Beziers
                            ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
                            for (let i = 1; i < pixelPoints.length - 1; i++) {
                                const curr = pixelPoints[i];
                                const next = pixelPoints[i + 1];
                                const midX = (curr.x + next.x) / 2;
                                const midY = (curr.y + next.y) / 2;
                                ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
                            }
                            // Final segment to the last point
                            const last2 = pixelPoints[pixelPoints.length - 2];
                            const last = pixelPoints[pixelPoints.length - 1];
                            ctx.quadraticCurveTo(last2.x, last2.y, last.x, last.y);
                        }

                        ctx.stroke();
                    }
                }
                break;

            case 'fib':
                this.drawFibonacci(ctx, drawing, start, end);
                break;
        }
    }

    drawFibonacci(ctx, drawing, start, end) {
        const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const colors = ['#06ffa5', '#4cc9f0', '#9d4edd', '#f72585', '#ff6b35', '#ffaa00', '#06ffa5'];
        
        const height = end.y - start.y;
        
        levels.forEach((level, i) => {
            const y = start.y + (height * level);
            ctx.strokeStyle = colors[i];
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(start.x, y);
            ctx.lineTo(end.x, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Label
            ctx.fillStyle = colors[i];
            ctx.font = '11px monospace';
            ctx.fillText(`${(level * 100).toFixed(1)}%`, end.x + 5, y + 4);
        });
    }

    clearAllDrawings() {
        if (this.drawings.length === 0) return;
        this.pushUndoState();
        this.drawings = [];
        this.redoStack = [];
        this.redrawCanvas();
    }

    deleteSelectedDrawing() {
        // Implement selection and deletion logic
    }

    // Save current drawings to undo stack
    pushUndoState() {
        const snapshot = this.drawings.map(d => JSON.parse(JSON.stringify(d)));
        this.undoStack.push(snapshot);
        // Any new action clears redo history
        this.redoStack = [];
    }

    undo() {
        if (this.undoStack.length === 0) return;
        const current = this.drawings.map(d => JSON.parse(JSON.stringify(d)));
        this.redoStack.push(current);
        this.drawings = this.undoStack.pop() || [];
        this.redrawCanvas();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const current = this.drawings.map(d => JSON.parse(JSON.stringify(d)));
        this.undoStack.push(current);
        this.drawings = this.redoStack.pop() || [];
        this.redrawCanvas();
    }

    changeTimeframe(timeframe) {
        console.log(`Switching to ${timeframe} timeframe`);
        // Emit event for app.js to handle
        const event = new CustomEvent('timeframe-change', { detail: { timeframe } });
        document.dispatchEvent(event);
    }

    addIndicator(type) {
        console.log(`Adding indicator: ${type}`);
        // Emit event for app.js to handle
        const event = new CustomEvent('indicator-add', { detail: { type } });
        document.dispatchEvent(event);
    }
}

// Export for browser
if (typeof window !== 'undefined') {
    window.ChartTools = ChartTools;
}

