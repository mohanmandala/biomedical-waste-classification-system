import os
import gdown

MODEL_PATH = "models/final_model.keras"
FILE_ID    = "1Vsdw00SEFwpEiWk0hMFgJPpgQbv9k8FZ"

def download_model():
    if not os.path.exists(MODEL_PATH):
        print("Downloading model from Google Drive...")
        os.makedirs("models", exist_ok=True)
        url = f"https://drive.google.com/uc?id={FILE_ID}"
        gdown.download(url, MODEL_PATH, quiet=False)
        print("Model downloaded successfully!")
    else:
        print("Model already exists.")

if __name__ == "__main__":
    download_model()