# Verifying TrackForge releases

Every tagged image is built on GitHub Actions, scanned, SBOM'd, and signed
with cosign keyless (OIDC → Fulcio → Rekor transparency log).

## Verify the signature

```bash
cosign verify ghcr.io/albertpa00/trackforge:1.2.3 \
  --certificate-identity-regexp \
    'https://github.com/AlbertPa00/TrackForge/.github/workflows/release.yml@refs/tags/v1.2.3' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Inspect the SBOM

Each release attaches `sbom.spdx.json` (Syft, SPDX-JSON):

```bash
syft ghcr.io/albertpa00/trackforge:1.2.3 -o spdx-json > sbom.spdx.json
```

## Check the provenance

Images carry OCI labels — `org.opencontainers.image.source`, `.revision`,
`.version`:

```bash
docker inspect ghcr.io/albertpa00/trackforge:1.2.3 \
  --format '{{json .Config.Labels}}'
```

`GET /rest/api/2/serverInfo` on a running instance reports the same
`version`/`scmInfo`/`buildDate` — compare against the labels.
