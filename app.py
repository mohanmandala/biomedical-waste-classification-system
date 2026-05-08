"""
╔══════════════════════════════════════════════════════════════╗
║     BioWaste AI Monitor - Enterprise Grade System            ║
║     MobileNetV2 Transfer Learning | Flask | SQLite           ║
║     Classes: Blue, Red, Yellow, White, Non-Waste             ║
╚══════════════════════════════════════════════════════════════╝
  SELF-CONTAINED: No external utils/ folder required.
  Run: python app.py  →  http://localhost:5000
"""

from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, emit

import os, io, base64, csv, datetime, logging, sqlite3, threading
from PIL import Image
import numpy as np

# ──────────────────────────────────────────────
#  App Init
# ──────────────────────────────────────────────
app = Flask(__name__)

app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024   # 16 MB
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
#  Model Config
# ──────────────────────────────────────────────
_model        = None
BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH    = os.path.join(BASE_DIR, 'models', 'final_model.keras')
MODEL_VERSION = "MobileNetV2-v1.0"

# ⚠️ ORDER MUST match exactly how the model was trained (alphabetical by folder name)
# Verified from original working code: ['blue','non_waste','red','white','yellow']
CLASS_NAMES = ['blue', 'non_waste', 'red', 'white', 'yellow']

IMG_SIZE    = (224, 224)
CONF_THRESH = 0.60   # 60% threshold — matches original working code

# Display info keyed by raw model class name (lowercase, underscore)
CLASS_INFO = {
    'blue':      {'color': '#3B82F6', 'icon': '🔵', 'desc': 'General / Recyclable Waste',      'risk': 'Low',    'label': 'Blue'},
    'non_waste': {'color': '#22C55E', 'icon': '🟢', 'desc': 'No Biomedical Waste Detected',    'risk': 'None',   'label': 'Non-Waste'},
    'red':       {'color': '#EF4444', 'icon': '🔴', 'desc': 'Infectious / Hazardous Waste',    'risk': 'High',   'label': 'Red'},
    'white':     {'color': '#E2E8F0', 'icon': '⚪', 'desc': 'Sharps / Puncture-Proof Waste',   'risk': 'High',   'label': 'White'},
    'yellow':    {'color': '#EAB308', 'icon': '🟡', 'desc': 'Chemical / Pharmaceutical Waste', 'risk': 'Medium', 'label': 'Yellow'},
}

def get_model():
    global _model
    if _model is None:
        try:
            import tensorflow as tf
            logger.info(f"Loading model from: {MODEL_PATH}")
            _model = tf.keras.models.load_model(MODEL_PATH)
            logger.info("✅ Model loaded successfully")
        except Exception as e:
            logger.error(f"❌ Model load error: {e}")
    return _model

# ──────────────────────────────────────────────
#  Database  (self-contained, no utils/ needed)
# ──────────────────────────────────────────────
DB_DIR  = os.path.join(BASE_DIR, 'database')
DB_PATH = os.path.join(DB_DIR, 'biowaste.db')

def _conn():
    os.makedirs(DB_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    con = _conn()
    con.executescript("""
        CREATE TABLE IF NOT EXISTS predictions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name    TEXT    NOT NULL,
            confidence    REAL    NOT NULL,
            model_version TEXT    NOT NULL,
            user          TEXT    DEFAULT 'unknown',
            timestamp     TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_class     ON predictions(class_name);
        CREATE INDEX IF NOT EXISTS idx_timestamp ON predictions(timestamp);
    """)
    con.commit(); con.close()
    logger.info("✅ Database ready")

def log_prediction(class_name, confidence, model_version, user='unknown'):
    con = _conn()
    con.execute(
        "INSERT INTO predictions (class_name,confidence,model_version,user,timestamp) VALUES (?,?,?,?,?)",
        (class_name, confidence, model_version, user, datetime.datetime.now().isoformat())
    )
    con.commit(); con.close()

def _enrich(rows):
    """Add display label & color to every DB row for the UI."""
    result = []
    for r in rows:
        d = dict(r)
        info = CLASS_INFO.get(d['class_name'], {})
        d['label'] = info.get('label', d['class_name'].replace('_',' ').title())
        d['color'] = info.get('color', '#94A3B8')
        d['icon']  = info.get('icon',  '📦')
        result.append(d)
    return result

def get_history(page=1, limit=50, class_filter=None):
    con = _conn()
    off = (page - 1) * limit
    if class_filter:
        # accept filter by raw_class (e.g. 'red') OR display label (e.g. 'Red')
        raw = class_filter.lower().replace('-','_').replace(' ','_')
        rows = con.execute(
            "SELECT * FROM predictions WHERE class_name=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (raw, limit, off)
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT * FROM predictions ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, off)
        ).fetchall()
    con.close()
    return _enrich(rows)

def get_summary():
    con   = _conn()
    total = con.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
    today = con.execute(
        "SELECT COUNT(*) FROM predictions WHERE DATE(timestamp)=DATE('now')"
    ).fetchone()[0]
    by_class_rows = con.execute("""
        SELECT class_name,
               COUNT(*)                  AS total,
               ROUND(AVG(confidence),2)  AS avg_confidence,
               ROUND(MIN(confidence),2)  AS min_confidence,
               ROUND(MAX(confidence),2)  AS max_confidence
        FROM predictions GROUP BY class_name ORDER BY total DESC
    """).fetchall()
    con.close()
    # Enrich with display labels
    by_class = []
    for r in by_class_rows:
        d    = dict(r)
        info = CLASS_INFO.get(d['class_name'], {})
        d['label'] = info.get('label', d['class_name'].replace('_',' ').title())
        d['color'] = info.get('color', '#94A3B8')
        by_class.append(d)
    return {'total': total, 'today': today, 'by_class': by_class}

def get_daily_trend(days=14):
    con  = _conn()
    rows = con.execute("""
        SELECT DATE(timestamp) AS date, class_name, COUNT(*) AS count
        FROM predictions
        WHERE timestamp >= DATE('now', ?)
        GROUP BY DATE(timestamp), class_name
        ORDER BY date ASC
    """, (f'-{days} days',)).fetchall()
    con.close()
    return [dict(r) for r in rows]

def delete_all_history():
    con = _conn()
    con.execute("DELETE FROM predictions")
    con.commit(); con.close()

# ──────────────────────────────────────────────
#  Init DB on startup
# ──────────────────────────────────────────────
with app.app_context():
    init_db()

# ──────────────────────────────────────────────
#  Page routes
# ──────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html',
        user='guest', role='admin',
        class_info=CLASS_INFO, model_version=MODEL_VERSION)

@app.route('/analytics')
def analytics():
    return render_template('analytics.html',
        user='guest', role='admin', class_info=CLASS_INFO)
# ──────────────────────────────────────────────
#  Auth API
# ──────────────────────────────────────────────


# ──────────────────────────────────────────────
#  Predict API
# ──────────────────────────────────────────────
@app.route('/api/predict', methods=['POST'])

def api_predict():
    try:
        if request.is_json:
            b64 = request.get_json().get('image', '')
            if ',' in b64: b64 = b64.split(',')[1]
            image_data = base64.b64decode(b64)
        else:
            f = request.files.get('image')
            if not f: return jsonify({'error': 'No image provided'}), 400
            image_data = f.read()

        # Preprocess
        img = Image.open(io.BytesIO(image_data)).convert('RGB').resize(IMG_SIZE)
        arr = np.expand_dims(np.array(img, dtype=np.float32) / 255.0, axis=0)

        # Infer
        model = get_model()
        if model is None:
            return jsonify({'error': 'Model unavailable. Install TensorFlow.'}), 503

        preds      = model.predict(arr, verbose=0)[0]
        idx        = int(np.argmax(preds))
        confidence = float(preds[idx])
        raw_class  = CLASS_NAMES[idx]          # e.g. 'non_waste', 'red'
        info       = CLASS_INFO[raw_class]
        label      = info['label']             # e.g. 'Non-Waste', 'Red'

        # All probabilities mapped to display labels
        all_probs = {
            CLASS_INFO[CLASS_NAMES[i]]['label']: round(float(preds[i]) * 100, 2)
            for i in range(len(CLASS_NAMES))
        }

        low_confidence = confidence < CONF_THRESH

        alert = None
        if raw_class in ['red', 'white'] and not low_confidence:
            alert = f"⚠️ HIGH RISK waste detected: {label} bag — immediate action required!"

        log_prediction(class_name=raw_class,
                       confidence=round(confidence * 100, 2),
                       model_version=MODEL_VERSION,
                       user='guest')

        result = {
            'class':             label,
            'raw_class':         raw_class,
            'confidence':        round(confidence * 100, 2),
            'all_probabilities': all_probs,
            'low_confidence':    low_confidence,
            'alert':             alert,
            'info':              info,
            'model_version':     MODEL_VERSION,
            'timestamp':         datetime.datetime.now().isoformat()
        }

        socketio.emit('new_prediction', result)
        if alert:
            socketio.emit('high_risk_alert', {'class': label, 'confidence': round(confidence * 100, 2)})

        return jsonify(result)

    except Exception as e:
        logger.error(f"Prediction error: {e}")
        return jsonify({'error': str(e)}), 500

# ──────────────────────────────────────────────
#  History & Analytics APIs
# ──────────────────────────────────────────────
@app.route('/api/history')

def api_history():
    return jsonify(get_history(
        page=int(request.args.get('page', 1)),
        limit=int(request.args.get('limit', 50)),
        class_filter=request.args.get('class')
    ))

@app.route('/api/analytics/summary')

def api_summary():
    return jsonify(get_summary())

@app.route('/api/analytics/daily')

def api_daily():
    return jsonify(get_daily_trend(days=int(request.args.get('days', 14))))

@app.route('/api/analytics/export')

def api_export():
    rows = get_history(page=1, limit=999999)
    out  = io.StringIO()
    w    = csv.writer(out)
    w.writerow(['ID', 'Class', 'Confidence (%)', 'Risk Level', 'Model Version', 'User', 'Timestamp'])
    for r in rows:
        w.writerow([r['id'], r.get('label', r['class_name']), r['confidence'],
                    CLASS_INFO.get(r['class_name'], {}).get('risk', 'N/A'),
                    r['model_version'], r.get('user', 'N/A'), r['timestamp']])
    out.seek(0)
    fname = f"biowaste_report_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return send_file(io.BytesIO(out.getvalue().encode()),
                     mimetype='text/csv', as_attachment=True, download_name=fname)

@app.route('/api/analytics/delete', methods=['DELETE'])


def api_delete():
    delete_all_history()
    socketio.emit('history_cleared', {'by': 'guest'})
    return jsonify({'success': True})

@app.route('/api/analytics/class-report')

def api_class_report():
    summary  = get_summary()
    by_class = {x['class_name']: x for x in summary.get('by_class', [])}
    return jsonify([{
        'class':          CLASS_INFO[c]['label'],   # display name: 'Non-Waste', 'Red'…
        'raw_class':      c,                         # raw model key: 'non_waste', 'red'…
        'info':           CLASS_INFO[c],
        'total':          by_class.get(c, {}).get('total', 0),
        'avg_confidence': by_class.get(c, {}).get('avg_confidence', 0),
    } for c in CLASS_NAMES])

@app.route('/api/health')
def api_health():
    return jsonify({
        'status':        'ok',
        'model_file':    os.path.exists(MODEL_PATH),
        'model_version': MODEL_VERSION,
        'timestamp':     datetime.datetime.now().isoformat()
    })

# ──────────────────────────────────────────────
#  WebSocket events
# ──────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    emit('connected', {'user': 'guest', 'role': 'admin'})

@socketio.on('ping_server')
def on_ping():
    emit('pong_server', {'time': datetime.datetime.now().isoformat()})

# ──────────────────────────────────────────────
#  Entry point
# ──────────────────────────────────────────────
if __name__ == '__main__':
    print("\n" + "="*55)
    print("  🏥  BioWaste AI Monitor  —  Starting up...")
    print("="*55)
    print(f"  📁  Model  : {MODEL_PATH}")
    print(f"  🗄️  Database: {DB_PATH}")
    print(f"  🌐  URL    : http://localhost:5000")
    print("  🔓  No login required — open access mode")
    print("="*55 + "\n")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
