#!/bin/bash
# Start Celery worker in the background
celery -A app.celery worker --loglevel=info &
# Start the Flask web server
gunicorn app:app
