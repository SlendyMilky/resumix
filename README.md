# Resumix

CV statique, ATS-friendly, avec import LinkedIn. Construit avec Astro, Tailwind CSS et hébergé sur Cloudflare Pages.

## Fonctionnalités

- **ATS-friendly** : HTML sémantique, JSON-LD Schema.org, hiérarchie de titres correcte
- **Thème sombre/clair** : détection automatique + toggle manuel
- **Responsive** : design mobile-first adaptatif
- **Export PDF** : via la fonction d'impression du navigateur (CSS `@media print` optimisé)
- **Import LinkedIn** : script CLI pour parser l'export ZIP de données LinkedIn
- **Statique** : aucun JavaScript requis pour le contenu, déployable sur n'importe quel CDN

## Prérequis

- Node.js >= 20
- Yarn 4.12 (via corepack)

## Installation

```bash
corepack enable
yarn install
```

## Développement

```bash
yarn dev
```

Le site est accessible sur `http://localhost:4321`.

## Personnaliser le CV

Éditez le fichier `src/data/resume.json` avec vos informations. La structure est typée avec TypeScript (voir `src/data/types.ts`).

### Import LinkedIn

1. Allez sur LinkedIn > Settings > Data privacy > Get a copy of your data
2. Sélectionnez les données souhaitées et demandez l'archive
3. Téléchargez le fichier ZIP reçu par email
4. Lancez l'import :

```bash
yarn linkedin-import ./chemin/vers/linkedin-export.zip
```

Le script va parser les CSV du ZIP et générer/mettre à jour `src/data/resume.json`. Relisez et complétez les champs manquants (highlights, technologies, etc.).

## Build

```bash
yarn build
```

Le site statique est généré dans `dist/`.

## Déploiement sur Cloudflare Pages

### Via le dashboard Cloudflare

1. Allez sur [Cloudflare Pages](https://pages.cloudflare.com/)
2. Connectez votre dépôt GitHub
3. Configurez le build :
   - **Build command** : `yarn build`
   - **Build output directory** : `dist`
   - **Node.js version** : `22`
4. Déployez

### Via Wrangler CLI

```bash
npx wrangler pages deploy dist
```

## Stack technique

| Outil | Version | Rôle |
|-------|---------|------|
| Astro | 5.x | Framework / SSG |
| Tailwind CSS | 4.x | Styling |
| TypeScript | 5.x | Typage |
| Yarn | 4.12 | Package manager |
| Cloudflare Pages | - | Hébergement |

## Structure du projet

```
src/
├── data/
│   ├── resume.json     # Données du CV
│   └── types.ts        # Types TypeScript
├── layouts/
│   └── Layout.astro    # Layout principal
├── components/
│   ├── Header.astro
│   ├── Experience.astro
│   ├── Education.astro
│   ├── Skills.astro
│   ├── Projects.astro
│   ├── Certifications.astro
│   ├── Languages.astro
│   ├── ThemeToggle.astro
│   └── PrintButton.astro
├── pages/
│   └── index.astro     # Page du CV
└── styles/
    └── global.css      # Styles + Tailwind
scripts/
└── linkedin-import.ts  # Import LinkedIn
```

## Licence

[MIT](LICENSE)
