import os
import json
import logging
import redis
import pandas as pd
from datetime import datetime
from flask import Flask, request, jsonify, render_template
from celery import Celery

# Flask App Configuration
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'

# ✅ Load Redis Cloud URL from environment variable for security
REDIS_URL = os.getenv("REDIS_URL", "redis://:your-redis-password@redis-11377.c72.eu-west-1-2.ec2.redns.redis-cloud.com:11377/0")

# ✅ Initialize Redis Connection
redis_client = redis.StrictRedis.from_url(REDIS_URL)

# ✅ Configure Celery with Redis Cloud
app.config['CELERY_BROKER_URL'] = REDIS_URL
app.config['CELERY_RESULT_BACKEND'] = REDIS_URL
celery = Celery(app.name, broker=app.config['CELERY_BROKER_URL'], backend=app.config['CELERY_RESULT_BACKEND'])
celery.conf.update(app.config)

# ✅ Ensure uploads directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ✅ Setup logging for debugging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ========================= Celery Task ========================= #
@celery.task(bind=True)
def analyze_data(self, column_select, reference_column_select, analysis_type, drill_down=None):
    try:
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], 'sales_data.csv')
        if not os.path.exists(file_path):
            return {'state': 'FAILURE', 'status': 'CSV file not found'}

        df = pd.read_csv(file_path, encoding='utf-8')

        # Ensure column_select is numeric
        df[column_select] = pd.to_numeric(df[column_select], errors='coerce')
        df.dropna(subset=[column_select], inplace=True)

        if reference_column_select and reference_column_select in df.columns:
            is_date_column = False
            first_value = df[reference_column_select].dropna().iloc[0] if not df[reference_column_select].dropna().empty else None
            if first_value:
                try:
                    pd.to_datetime(first_value)
                    is_date_column = True
                except (ValueError, TypeError):
                    pass

            if is_date_column:
                df[reference_column_select] = pd.to_datetime(df[reference_column_select], errors='coerce')
                df.dropna(subset=[reference_column_select], inplace=True)

                if drill_down:
                    month = drill_down.get('month', '').lower()
                    year = drill_down.get('year', '')
                    if month and year:
                        month_num = datetime.strptime(month, '%b').month
                        mask = (df[reference_column_select].dt.month == month_num) & \
                               (df[reference_column_select].dt.year == int(year))
                        day_data = df[mask]
                        if day_data.empty:
                            return {'state': 'SUCCESS', 'status': f'No data for {month.capitalize()} {year}', 
                                    'result': {'value': 0}, 
                                    'chart_data': {'labels': [], 'values': [], 'label': 'No Data'}}
                        grouped = day_data.groupby(day_data[reference_column_select].dt.date)[column_select].sum().reset_index()
                        labels = grouped[reference_column_select].dt.strftime('%Y-%m-%d').tolist()
                        values = grouped[column_select].tolist()
                        return {'state': 'SUCCESS', 'result': {'value': day_data[column_select].mean()}, 'chart_data': {'labels': labels, 'values': values, 'label': 'Day-wise Data'}}
                
                monthly_data = df.groupby(df[reference_column_select].dt.to_period('M'))[column_select].mean().reset_index()
                monthly_data[reference_column_select] = monthly_data[reference_column_select].dt.strftime('%b %Y')
                labels = monthly_data[reference_column_select].tolist()
                values = monthly_data[column_select].tolist()
            else:
                grouped_data = df.groupby(reference_column_select)[column_select].mean().reset_index()
                labels = grouped_data[reference_column_select].astype(str).tolist()
                values = grouped_data[column_select].tolist()
        else:
            labels = df.index.astype(str).tolist()
            values = df[column_select].tolist()

        return {'state': 'SUCCESS', 'result': {'value': df[column_select].mean()}, 'chart_data': {'labels': labels, 'values': values, 'label': 'Data'}}

    except Exception as e:
        logger.error(f"Error in analyze_data: {str(e)}")
        return {'state': 'FAILURE', 'status': str(e)}

# ========================= Flask Routes ========================= #
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_columns', methods=['POST'])
def get_columns():
    try:
        if 'data_file' not in request.files:
            return jsonify({'error': 'No file part'})
        
        file = request.files['data_file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'})

        if file.filename.endswith('.csv'):
            df = pd.read_csv(file, encoding='utf-8')
        elif file.filename.endswith('.xlsx'):
            df = pd.read_excel(file)
        elif file.filename.endswith('.json'):
            json_data = json.loads(file.read().decode('utf-8'))
            df = pd.DataFrame(json_data.get('sales', json_data)) if isinstance(json_data, (dict, list)) else None
        else:
            return jsonify({'error': 'Only CSV, XLSX, and JSON files are supported.'})

        if df is None:
            return jsonify({'error': 'Invalid JSON format'})

        df.rename(columns={'date': 'Date'}, inplace=True)
        df.to_csv(os.path.join(app.config['UPLOAD_FOLDER'], 'sales_data.csv'), index=False)
        return jsonify({'columns': df.columns.tolist()})

    except Exception as e:
        logger.error(f"Error in get_columns: {str(e)}")
        return jsonify({'error': str(e)})

@app.route('/analyze', methods=['POST'])
def analyze():
    try:
        form_data = request.form
        result = analyze_data.delay(
            column_select=form_data.get('column_select'),
            reference_column_select=form_data.get('reference_column_select'),
            analysis_type=form_data.get('analysis_type'),
            drill_down=json.loads(form_data.get('drill_down', '{}')) if form_data.get('drill_down') else None
        )
        return jsonify({'task_id': result.id})
    except Exception as e:
        logger.error(f"Error in analyze: {str(e)}")
        return jsonify({'error': str(e)})

@app.route('/task_status/<task_id>')
def task_status(task_id):
    task_result = analyze_data.AsyncResult(task_id)
    return jsonify({'state': task_result.state, 'status': str(task_result.result) if task_result.state == 'FAILURE' else '', 'result': task_result.result})

if __name__ == '__main__':
    app.run(debug=True)
