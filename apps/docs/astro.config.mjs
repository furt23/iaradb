import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.workhouse.dev',
  integrations: [
    starlight({
      title: 'Iara',
      logo: { light: './src/assets/logo-light.svg', dark: './src/assets/logo-dark.svg' },
      description: 'Official Python API documentation and reference for the Iara Engine.',
      defaultLocale: 'root',
      locales: {
        root: {
          label: 'English',
          lang: 'en',
        },
      },
      components: {
        SocialIcons: './src/components/HeaderLinks.astro',
      },
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource-variable/jetbrains-mono',
        '@fontsource-variable/roboto-slab',
        './src/styles/custom.css',
      ],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        shiki: {
          bundledLangs: ['python', 'bash', 'sql', 'json', 'yaml', 'toml'],
        },
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Quickstart Guide', slug: 'quickstart' },
          ],
        },
        {
          label: 'Top-Level Functions',
          items: [
            { label: 'Overview', slug: 'top-level' },
            { label: 'I/O & Constructors', slug: 'top-level/io' },
            { label: 'Engine Control & Config', slug: 'top-level/engine' },
          ],
        },
        {
          label: 'LazyFrame API',
          items: [
            { label: 'Overview', slug: 'lazyframe' },
            { label: 'Selection & Projections', slug: 'lazyframe/selection' },
            { label: 'Filtering & Slicing', slug: 'lazyframe/filtering' },
            { label: 'Grouping & Aggregations', slug: 'lazyframe/grouping' },
            { label: 'Joins & Set Operations', slug: 'lazyframe/joins' },
            { label: 'Sorting & Reordering', slug: 'lazyframe/sorting' },
            { label: 'Execution & Plans', slug: 'lazyframe/execution' },
            { label: 'Streaming & Sinks', slug: 'lazyframe/streaming' },
          ],
        },
        {
          label: 'DataFrame API',
          items: [
            { label: 'Overview', slug: 'dataframe' },
            { label: 'Inspection & Properties', slug: 'dataframe/inspection' },
            { label: 'Interoperability (Arrow / Pandas / Polars)', slug: 'dataframe/interop' },
            { label: 'Export & Writing', slug: 'dataframe/io' },
            { label: 'Eager Operations', slug: 'dataframe/eager' },
          ],
        },
        {
          label: 'Column Expressions (Expr)',
          items: [
            { label: 'Overview', slug: 'expressions' },
            { label: 'Operators & Predicates', slug: 'expressions/operators' },
            { label: 'Aggregations', slug: 'expressions/aggregations' },
            { label: 'Math Functions', slug: 'expressions/math' },
            { label: 'String Namespace (str)', slug: 'expressions/strings' },
            { label: 'DateTime Namespace (dt)', slug: 'expressions/datetime' },
            { label: 'Conditionals (when/then)', slug: 'expressions/conditionals' },
          ],
        },
        {
          label: 'Window Functions',
          items: [
            { label: 'Overview & over()', slug: 'window' },
            { label: 'Ranking Functions', slug: 'window/ranking' },
            { label: 'Offsets & Differences', slug: 'window/offsets' },
            { label: 'Cumulative Aggregations', slug: 'window/cumulative' },
            { label: 'Rolling Windows', slug: 'window/rolling' },
          ],
        },
        {
          label: 'SessionContext & SQL',
          items: [
            { label: 'Overview & wh.sql()', slug: 'sql-session' },
            { label: 'Catalog & Tables', slug: 'sql-session/catalog' },
            { label: 'Warehouse & DDL', slug: 'sql-session/warehouse' },
          ],
        },
        {
          label: 'Storage & Cloud',
          items: [
            { label: 'S3 & Cloudflare R2', slug: 'storage' },
            { label: 'Request Optimization', slug: 'storage/optimization' },
          ],
        },
        {
          label: 'Runtime & Memory',
          items: [
            { label: 'Resource Management', slug: 'runtime' },
            { label: 'Query Management & Cancellation', slug: 'runtime/queries' },
          ],
        },
      ],
    }),
  ],
});
