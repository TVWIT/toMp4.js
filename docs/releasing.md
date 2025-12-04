# Releasing

## Quick Release (Automated)

```bash
npm run release:patch   # 1.0.5 → 1.0.6
npm run release:minor   # 1.0.5 → 1.1.0
npm run release:major   # 1.0.5 → 2.0.0
```

That's it! The script will:
1. Bump version in `package.json`
2. Build the dist files
3. Commit changes
4. Create a git tag (e.g., `v1.0.6`)
5. Push commit and tag to GitHub

Then GitHub Actions automatically:
1. Creates a GitHub Release with auto-generated release notes
2. Attaches the built `dist/tomp4.js` to the release
3. Publishes to npm

## Setup Required

### NPM Token (one-time)

1. Go to [npmjs.com](https://www.npmjs.com/) → Account Settings → Access Tokens
2. Generate a new "Automation" token
3. Go to your GitHub repo → Settings → Secrets and variables → Actions
4. Add a new secret: `NPM_TOKEN` with the token value

### GitHub Pages Link (one-time)

1. Go to your GitHub repo
2. Click the ⚙️ gear next to "About" (right sidebar)
3. Add website: `https://tvwit.github.io/toMp4.js/`

## Manual Release

If you need to release manually:

```bash
# Bump version
npm version patch --no-git-tag-version

# Build
npm run build

# Commit, tag, and push
git add -A
git commit -m "v1.0.6"
git tag v1.0.6
git push && git push --tags

# Publish to npm (if not using GitHub Actions)
npm publish --access=public
```

## Notes

- Package is scoped to `@invintusmedia`
- `--access=public` is required for scoped packages
- Version is auto-injected into `src/index.js` and `dist/tomp4.js` during build
- GitHub Actions uses `softprops/action-gh-release` for releases
- Release notes are auto-generated from commits since last release
