#!/bin/sh
# GeekEZ Browser - Alpine Linux Setup Script
# For proot/VNC environments

echo "============================================"
echo "  GeekEZ Browser - Alpine Setup"
echo "============================================"

# Install dependencies
echo "[1/4] Installing system dependencies..."
apk add --no-cache \
    nodejs \
    npm \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-cjk \
    xvfb \
    dbus

# Create fonts directory if not exists
mkdir -p /usr/share/fonts

# Set up environment
echo "[2/4] Setting up environment..."
export CHROME_PATH=/usr/bin/chromium-browser
export DISPLAY=:0

# Install Node.js dependencies
echo "[3/4] Installing Node.js dependencies..."
if [ -f package-server.json ]; then
    cp package-server.json package.json.bak
    cp package-server.json package.json
fi
npm install --omit=dev

# Create startup script
echo "[4/4] Creating startup script..."
cat > start-server.sh << 'EOF'
#!/bin/sh
export CHROME_PATH=/usr/bin/chromium-browser
export DISPLAY=${DISPLAY:-:0}
export GEEKEZ_DATA_PATH=${GEEKEZ_DATA_PATH:-$HOME/.geekez-browser}
export API_PORT=${API_PORT:-3000}

# Start Xvfb if no display available (for headless VNC setup)
if ! xdpyinfo -display $DISPLAY >/dev/null 2>&1; then
    echo "Starting virtual display..."
    Xvfb $DISPLAY -screen 0 1920x1080x24 &
    sleep 1
fi

echo "Starting GeekEZ Browser Server..."
node server.js
EOF
chmod +x start-server.sh

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Usage:"
echo "  ./start-server.sh"
echo ""
echo "Environment variables:"
echo "  CHROME_PATH      - Chrome binary path (default: /usr/bin/chromium-browser)"
echo "  DISPLAY          - X11 display (default: :0)"
echo "  GEEKEZ_DATA_PATH - Data directory (default: ~/.geekez-browser)"
echo "  API_PORT         - API port (default: 3000)"
echo ""
echo "API Examples:"
echo "  curl http://localhost:3000/api/status"
echo "  curl http://localhost:3000/api/profiles"
echo "  curl -X POST http://localhost:3000/api/profiles -H 'Content-Type: application/json' -d '{\"name\":\"test\"}'"
echo "  curl http://localhost:3000/api/open/test"
echo ""
