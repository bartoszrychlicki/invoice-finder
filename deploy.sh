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

# 2. Przygotowanie zmiennych środowiskowych z .env do formatu YAML
echo "⚙️ Konwertowanie .env do env.yaml..."
if [ ! -f .env ]; then
    echo "❌ Brak pliku .env!"
    exit 1
fi

# Utwórz tymczasowy plik env.yaml
> env.yaml

while IFS='=' read -r key value; do
    # Pomiń komentarze i puste linie
    if [[ $key =~ ^#.* ]] || [[ -z $key ]]; then
        continue
    fi
    
    # Pomiń PORT
    if [[ "$key" == "PORT" ]]; then
        continue
    fi
    
    # Usuń cudzysłowy z wartości
    value="${value%\"}"
    value="${value#\"}"
    
    # Zapisz do env.yaml w formacie klucz: "wartość"
    echo "$key: \"$value\"" >> env.yaml
done < .env

# 3. Wdrażanie na Cloud Run
echo "☁️ Wdrażanie na Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE_NAME \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --env-vars-file env.yaml

# Usuń plik tymczasowy
rm env.yaml

if [ $? -eq 0 ]; then
    echo "✅ Wdrożenie zakończone sukcesem!"
    echo "🌍 URL usługi:"
    gcloud run services describe $SERVICE_NAME --platform managed --region us-central1 --format 'value(status.url)'
else
    echo "❌ Błąd podczas wdrażania."
    exit 1
fi
