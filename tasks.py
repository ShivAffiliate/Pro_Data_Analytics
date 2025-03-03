from celery import Celery
import pandas as pd
from datetime import datetime
import os
import logging

# Configure Celery
celery = Celery('tasks', broker='redis://localhost:6379/0', backend='redis://localhost:6379/0')

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@celery.task(bind=True)
def analyze_data(self, column_select, reference_column_select, analysis_type, drill_down=None):
    """Celery task to analyze data from a CSV file, supporting monthly and day-wise views."""
    try:
        # Load the CSV file
        file_path = os.path.join('uploads', 'sales_data.csv')
        if not os.path.exists(file_path):
            return {'state': 'FAILURE', 'status': 'CSV file not found'}

        # Read CSV with date parsing
        df = pd.read_csv(file_path, parse_dates=[reference_column_select], encoding='utf-8')

        # Log sample of date column for debugging
        logger.debug(f"Sample of {reference_column_select} column before parsing: {df[reference_column_select].head().tolist()}")

        # Ensure date column is datetime64
        if not pd.api.types.is_datetime64_any_dtype(df[reference_column_select]):
            df[reference_column_select] = pd.to_datetime(df[reference_column_select], errors='coerce', format='%Y-%m-%d')
            if df[reference_column_select].isna().any():
                # Try multiple date formats
                def try_formats(date_str):
                    if pd.isna(date_str) or date_str == '' or date_str == 'NaN':
                        return pd.NaT
                    formats = ['%Y-%m-%d', '%m/%d/%Y', '%d-%m-%Y', '%B %d, %Y', '%Y/%m/%d', '%d-%b-%Y', '%Y-%b-%d']
                    for fmt in formats:
                        try:
                            return pd.to_datetime(date_str, format=fmt, errors='coerce')
                        except ValueError:
                            continue
                    try:
                        return pd.to_datetime(date_str, errors='coerce', infer_datetime_format=True)
                    except Exception as e:
                        logger.error(f"Failed to parse date {date_str}: {str(e)}")
                        return pd.NaT
                df[reference_column_select] = df[reference_column_select].apply(try_formats)
            invalid_dates = df[reference_column_select].isna().sum()
            if invalid_dates > 0:
                logger.warning(f"Found {invalid_dates} invalid dates in {reference_column_select}. Dropping rows.")
                df = df.dropna(subset=[reference_column_select])
            if not pd.api.types.is_datetime64_any_dtype(df[reference_column_select]):
                return {'state': 'FAILURE', 'status': f'Column {reference_column_select} not datetimelike after parsing.'}

        # Ensure selected column is numeric
        df[column_select] = pd.to_numeric(df[column_select], errors='coerce')
        if df[column_select].isna().any():
            logger.warning(f"Non-numeric values in {column_select}. Dropping rows.")
            df = df.dropna(subset=[column_select])

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
                # Group by day and sum
                day_data_grouped = day_data.groupby(day_data[reference_column_select].dt.date)[column_select].sum().reset_index()
                # Convert date column back to datetime64
                day_data_grouped[reference_column_select] = pd.to_datetime(day_data_grouped[reference_column_select])
                logger.info(f"Day-wise data for {month} {year}: {day_data_grouped}")
                day_labels = day_data_grouped[reference_column_select].dt.strftime('%Y-%m-%d').tolist()
                day_values = day_data_grouped[column_select].tolist()
                chart_data = {'labels': day_labels, 'values': day_values, 'label': 'Day-wise Data'}
                result = {'value': day_data[column_select].mean()}
                return {'state': 'SUCCESS', 'result': result, 'chart_data': chart_data}

        # Monthly aggregation
        monthly_data = df.groupby(df[reference_column_select].dt.to_period('M'))[column_select].mean().reset_index()
        monthly_data[reference_column_select] = monthly_data[reference_column_select].dt.strftime('%b %Y')
        labels = monthly_data[reference_column_select].tolist()
        values = monthly_data[column_select].tolist()
        chart_data = {'labels': labels, 'values': values, 'label': 'Monthly Data'}
        result = {'value': df[column_select].mean()}

        return {'state': 'SUCCESS', 'result': result, 'chart_data': chart_data}

    except Exception as e:
        logger.error(f"Error in analyze_data: {str(e)}")
        return {'state': 'FAILURE', 'status': str(e)}