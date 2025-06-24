#!/bin/bash

# Kill existing process if running
PORT=3000
PID=$(lsof -ti:$PORT)

if [ ! -z "$PID" ]; then
    echo "Stopping existing process on port $PORT (PID: $PID)..."
    kill -9 $PID
    sleep 1
fi

echo "Starting BetaSeries to Sonarr List Generator..."
nodemon index.js