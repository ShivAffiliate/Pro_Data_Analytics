from flask import Flask, request, jsonify, render_template
from celery import Celery
import os
import pandas as pd
import json
from datetime import datetime
import logging

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['CELERY_BROKER_URL'] = 'redis://localhost:6379/0'
app.config['CELERY_RESULT_BACKEND'] = 'redis://localhost:6379/0'

celery = Celery(app.name, broker=app.config['CELERY_BROKER_URL'], backend=app.config['CELERY_RESULT_BACKEND'])
celery.conf.update(app.config)

# Ensure uploads directory exists
if not os.path.exists(app.config['UPLOAD_FOLDER']):
    os.makedirs(app.config['UPLOAD_FOLDER'])

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@celery.task(bind=True)
def analyze_data(self, column_select, reference_column_select, analysis_type, drill_down=None):
    try:
        # Load the CSV file
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], 'sales_data.csv')
        if not os.path.exists(file_path):
            return {'state': 'FAILURE', 'status': 'CSV file not found'}

        # Load CSV
        df = pd.read_csv(file_path, encoding='utf-8')

        # Ensure column_select is numeric
        df[column_select] = pd.to_numeric(df[column_select], errors='coerce')
        if df[column_select].isna().any():
            logger.warning(f"Non-numeric values in {column_select}. Dropping rows with NaN.")
            df = df.dropna(subset=[column_select])

        if reference_column_select:
            # Verify the reference column exists
            if reference_column_select not in df.columns:
                return {'state': 'FAILURE', 'status': f"Selected column '{reference_column_select}' not found in data"}

            # Check if the column is a date column
            is_date_column = False
            first_value = df[reference_column_select].dropna().iloc[0] if not df[reference_column_select].dropna().empty else None
            if first_value is not None:
                try:
                    pd.to_datetime(first_value)
                    is_date_column = True
                except (ValueError, TypeError):
                    pass
            logger.info(f"Reference column '{reference_column_select}' detected as {'date' if is_date_column else 'non-date'}")

            if is_date_column:
                # Parse as datetime
                df[reference_column_select] = pd.to_datetime(df[reference_column_select], errors='coerce')
                if df[reference_column_select].isna().any():
                    invalid_dates = df[reference_column_select].isna().sum()
                    logger.warning(f"Found {invalid_dates} invalid dates in {reference_column_select}. Dropping rows with NaT.")
                    df = df.dropna(subset=[reference_column_select])
                if df.empty:
                    return {'state': 'SUCCESS', 'status': 'No valid data after date parsing', 
                            'result': {'value': 0}, 
                            'chart_data': {'labels': [], 'values': [], 'label': 'No Data'}}

                if drill_down:
                    month = drill_down.get('month', '').lower()
                    year = drill_down.get('year', '')
                    if month and year:
                        month_num = datetime.strptime(month, '%b').month
                        mask = (df[reference_column_select].dt.month == month_num) & \
                               (df[reference_column_select].dt.year == int(year))
                        day_data = df[mask]
                        if day_data.empty:
                            return {'state': 'SUCCESS', 'status': f'No day-wise data for {month.capitalize()} {year}', 
                                    'result': {'value': 0}, 
                                    'chart_data': {'labels': [], 'values': [], 'label': 'No Data'}}
                        day_data_grouped = day_data.groupby(day_data[reference_column_select].dt.date)[column_select].sum().reset_index()
                        day_data_grouped[reference_column_select] = pd.to_datetime(day_data_grouped[reference_column_select])
                        logger.info(f"Day-wise aggregation for {month} {year}: {day_data_grouped}")
                        day_labels = day_data_grouped[reference_column_select].dt.strftime('%Y-%m-%d').tolist()
                        day_values = day_data_grouped[column_select].tolist()
                        chart_data = {'labels': day_labels, 'values': day_values, 'label': 'Day-wise Data'}
                        result = {'value': day_data[column_select].mean()}
                        return {'state': 'SUCCESS', 'result': result, 'chart_data': chart_data}
                else:
                    # Monthly aggregation
                    monthly_data = df.groupby(df[reference_column_select].dt.to_period('M'))[column_select].mean().reset_index()
                    monthly_data[reference_column_select] = monthly_data[reference_column_select].dt.strftime('%b %Y')
                    labels = monthly_data[reference_column_select].tolist()
                    values = monthly_data[column_select].tolist()
            else:
                # Non-date column: group by the column
                grouped_data = df.groupby(reference_column_select)[column_select].mean().reset_index()
                labels = grouped_data[reference_column_select].astype(str).tolist()
                values = grouped_data[column_select].tolist()
        else:
            # No reference column: use index
            labels = df.index.astype(str).tolist()
            values = df[column_select].tolist()

        chart_data = {'labels': labels, 'values': values, 'label': 'Data'}
        result = {'value': df[column_select].mean()}
        return {'state': 'SUCCESS', 'result': result, 'chart_data': chart_data}

    except Exception as e:
        logger.error(f"Error in analyze_data: {str(e)}")
        return {'state': 'FAILURE', 'status': str(e)}

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
            file_content = file.read().decode('utf-8')
            json_data = json.loads(file_content)
            if isinstance(json_data, list):
                df = pd.DataFrame(json_data)
            elif isinstance(json_data, dict) and 'sales' in json_data:
                df = pd.DataFrame(json_data['sales'])
            else:
                return jsonify({'error': 'Invalid JSON format. Expected an array or object with "sales" key.'})
        else:
            return jsonify({'error': 'Only CSV, XLSX, and JSON files are supported.'})

        # Standardize date column name
        if 'date' in df.columns:
            df.rename(columns={'date': 'Date'}, inplace=True)

        # Save the processed DataFrame as CSV
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], 'sales_data.csv')
        df.to_csv(file_path, index=False)

        # Return the standardized column names
        columns = df.columns.tolist()
        return jsonify({'columns': columns})

    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON: {str(e)}")
        return jsonify({'error': f'Invalid JSON: {str(e)}'})
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
    if task_result.state == 'PENDING':
        return jsonify({'state': task_result.state, 'status': 'Processing...'})
    elif task_result.state == 'FAILURE':
        return jsonify({'state': task_result.state, 'status': str(task_result.result)})
    else:
        return jsonify({'state': task_result.state, 'result': task_result.result})

if __name__ == '__main__':
    app.run(debug=True)