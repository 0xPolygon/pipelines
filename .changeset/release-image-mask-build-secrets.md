---
---

CI-only: gcp_pipeline_release_image.yaml no longer prints decoded build secrets to job logs (removed `cat .env`), masks every secret value before use, and passes the secret JSON via `env:` instead of interpolating it into the script (empty changeset — no package ships).
