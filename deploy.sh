#!/bin/bash

# Sprawdź czy gcloud jest zainstalowany
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI nie jest zainstalowane. Zainstaluj Google Cloud SDK."
    exit 1
fi

# Pobierz Project ID
PROJECT_ID=$(gcloud config get-value project)
if [ -z "$PROJECT_ID" ]; then
    echo "⚠️ Nie wykryto aktywnego projektu w gcloud."
    read -p "Podaj swoje Google Cloud Project ID: " PROJECT_ID
fi

echo "🚀 Rozpoczynam wdrażanie na projekt: $PROJECT_ID"

# Nazwa usługi i obrazu
SERVICE_NAME="gmail-invoice-scanner"
IMAGE_NAME="gcr.io/$PROJECT_ID/$SERVICE_NAME"

# 1. Budowanie obrazu
echo "📦 Budowanie obrazu Docker..."
gcloud builds submit --tag $IMAGE_NAME

if [ $? -ne 0 ]; then
    echo "❌ Błąd podczas budowania obrazu."
    exit 1
fi

# 2. Przygotowanie zmiennych środowiskowych z .env
echo "⚙️ Wczytywanie zmiennych z .env..."
if [ ! -f .env ]; then
    echo "❌ Brak pliku .env!"
    exit 1
fi

# Budowanie stringa zmiennych środowiskowych
ENV_VARS=""
while IFS='=' read -r key value; do
    # Pomiń komentarze i puste linie
    if [[ $key =~ ^#.* ]] || [[ -z $key ]]; then
        continue
    fi
    
    # Pomiń PORT, ponieważ jest zarezerwowany w Cloud Run
    if [[ "$key" == "PORT" ]]; then
        continue
    fi
    # Dodaj do listy (z przecinkiem jako separatorem)
    if [ -n "$ENV_VARS" ]; then
        ENV_VARS="$ENV_VARS,"
    fi
    ENV_VARS="$ENV_VARS$key=$value"
done < .env

# 3. Wdrażanie na Cloud Run
echo "☁️ Wdrażanie na Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE_NAME \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "$ENV_VARS"

if [ $? -eq 0 ]; then
    echo "✅ Wdrożenie zakończone sukcesem!"
    echo "🌍 URL usługi:"
    gcloud run services describe $SERVICE_NAME --platform managed --region us-central1 --format 'value(status.url)'
else
    echo "❌ Błąd podczas wdrażania."
    exit 1
fi
