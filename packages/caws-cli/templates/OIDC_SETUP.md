# OIDC Trusted Publisher Setup

This guide helps you set up OIDC (OpenID Connect) trusted publisher for automated publishing to package registries.

## Overview

OIDC trusted publisher allows you to publish packages without storing long-lived tokens or passwords in your CI/CD environment. Instead, it uses short-lived tokens issued by the OIDC provider.

## Supported Registries

- **npm**: npm Registry
- **PyPI**: Python Package Index
- **Maven Central**: Java packages
- **NuGet**: .NET packages

## Setup Process

### 1. Configure OIDC Provider

Most CI/CD platforms (GitHub Actions, GitLab CI, etc.) provide built-in OIDC support.

**GitHub Actions Example:**

```yaml
# .github/workflows/publish.yml
name: Publish Package

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - name: Install dependencies
        run: npm ci
      - name: Build package
        run: npm run build
      - name: Publish to npm
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 2. Registry Configuration

#### npm Registry

1. **Create OIDC Integration**:

   ```bash
   # Using npm CLI
   npm profile enable-2fa auth-and-writes
   ```

2. **Configure Trusted Publisher**:
   - Go to npmjs.com → Account Settings → Access Tokens
   - Create "Automation" token
   - Configure OIDC integration

3. **Repository Settings**:
   ```json
   // package.json
   {
     "publishConfig": {
       "registry": "https://registry.npmjs.org/"
     }
   }
   ```

#### PyPI (Python)

1. **Create API Token**:

   ```bash
   # Using twine
   twine upload --config-file ~/.pypirc dist/*
   ```

2. **OIDC Configuration**:
   ```yaml
   # .github/workflows/publish.yml
   - name: Publish to PyPI
     uses: pypa/gh-action-pypi-publish@release/v1
     with:
       password: ${{ secrets.PYPI_API_TOKEN }}
   ```

### 3. Security Best Practices

#### Token Management

- ✅ **Use short-lived tokens** (1-6 hours)
- ✅ **Scope tokens to specific repositories**
- ✅ **Rotate tokens regularly**
- ❌ **Never store long-lived tokens in code**
- ❌ **Never commit tokens to version control**

#### Environment Variables

```bash
# Good: Short-lived, scoped token
NODE_AUTH_TOKEN=gho_shortlivedtoken123

# Bad: Long-lived, broad token
NPM_TOKEN=longlivedbroadtoken456
```

#### Repository Secrets

Store sensitive tokens in repository secrets:

**GitHub**: Settings → Secrets and variables → Actions
**GitLab**: Settings → CI/CD → Variables
**Azure DevOps**: Pipelines → Library → Variable groups

### 4. Testing the Setup

#### Local Testing

```bash
# Test with dry run
npm publish --dry-run

# Test with local registry
npm publish --registry http://localhost:4873
```

#### CI/CD Testing

```yaml
# Add to your workflow for testing
- name: Test publish (dry run)
  run: npm publish --dry-run
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 5. Troubleshooting

#### Common Issues

**Token Expired**:

```
npm ERR! code E401
npm ERR! Unable to authenticate, need: Basic
```

**Solution**: Check token expiration and refresh if needed.

**Insufficient Permissions**:

```
npm ERR! code E403
npm ERR! Forbidden
```

**Solution**: Verify token has publish permissions for the package.

**OIDC Provider Issues**:

```
Error: Failed to get OIDC token
```

**Solution**: Check OIDC provider configuration and permissions.

#### Debug Mode

Enable debug logging:

```bash
# npm
npm config set loglevel verbose

# Python
export TWINE_VERBOSE=1

# Maven
mvn deploy -X
```

### 6. Migration from Legacy Tokens

If you're migrating from username/password or long-lived tokens:

1. **Audit existing tokens**:

   ```bash
   # npm
   npm profile get

   # List all tokens
   npm token list
   ```

2. **Revoke old tokens**:

   ```bash
   npm token delete <token-id>
   ```

3. **Update CI/CD workflows**:
   - Replace `NPM_TOKEN` with `NODE_AUTH_TOKEN`
   - Add OIDC permissions
   - Test in staging environment

### 7. Monitoring and Alerts

Set up monitoring for:

- **Publish failures**: Alert on failed deployments
- **Token expiration**: Proactive token renewal
- **Security events**: Unusual publish patterns
- **Registry status**: External service health

#### Example Monitoring

```yaml
# .github/workflows/monitor.yml
name: Monitor Publishing

on:
  workflow_run:
    workflows: ['Publish Package']
    types: [completed]

jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - name: Check publish status
        if: ${{ github.event.workflow_run.conclusion == 'failure' }}
        run: |
          echo "Publish failed! Check logs."
          # Send alert to Slack/Teams/etc.
```

## CAWS Integration

For CAWS projects, OIDC setup integrates with:

- **Provenance tracking**: Automatic attestation of published packages
- **Security scanning**: Validation of published artifacts
- **Quality gates**: Ensure packages meet standards before publish

### CAWS-Specific Configuration

```yaml
# .caws/working-spec.yaml
non_functional:
  security:
    - 'oidc-authentication'
    - 'token-rotation'
    - 'publish-attestation'
```

### Automated Provenance

CAWS automatically generates provenance information:

```bash
# Generate SBOM and attestation
caws attest --format=slsa

# Validate before publish
caws validate --security-scan
```

## Resources

- [npm OIDC Documentation](https://docs.npmjs.com/about-access-tokens)
- [GitHub Actions OIDC](https://docs.github.com/en/actions/deployment/security/hardening-your-deployments/about-security-hardening-with-openid-connect)
- [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishing/)
- [OIDC Specification](https://openid.net/connect/)

## Support

For issues with OIDC setup:

1. Check the troubleshooting section above
2. Review registry-specific documentation
3. Open an issue in the CAWS repository
4. Contact your organization's security team

---

**Note**: This guide provides general OIDC setup instructions. Always follow your organization's specific security policies and procedures.

