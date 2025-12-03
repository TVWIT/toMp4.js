# Releasing

## Quick Release

```bash
npm run release:patch   # 1.0.2 → 1.0.3
npm run release:minor   # 1.0.2 → 1.1.0
npm run release:major   # 1.0.2 → 2.0.0
```

Then publish:

```bash
npm publish --access=public
```

## What the release scripts do

1. Bump version in `package.json`
2. Run build (injects version into dist + src)
3. Commit all changes
4. Push to GitHub

## Manual Release

```bash
# Bump version
npm version patch --no-git-tag-version

# Build
npm run build

# Commit and push
git add -A
git commit -m "v1.0.3"
git push

# Publish to npm
npm publish --access=public
```

## First-time setup

Make sure you're logged into npm:

```bash
npm login
```

## Notes

- The package is scoped to `@invintusmedia`
- `--access=public` is required for scoped packages
- Version is auto-injected into `src/index.js` and `dist/tomp4.js` during build
- Demo page reads version from the library at runtime


