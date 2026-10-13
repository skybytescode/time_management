#!/bin/sh
# Installs Piper and the en_GB-jenny_dioco-medium voice into the app's data directory,
# so the assistant can speak text generated at runtime.
# Usage: sh scripts/install-voice.sh
set -eu

data="${XDG_DATA_HOME:-$HOME/.local/share}/com.skybytescode.timemanagement"
voice=en_GB-jenny_dioco-medium

python3 -m venv "$data/piper"
"$data/piper/bin/pip" install --quiet --upgrade piper-tts
mkdir -p "$data/voices"
"$data/piper/bin/python" -m piper.download_voices --data-dir "$data/voices" "$voice"

echo "Voice installed in $data"
