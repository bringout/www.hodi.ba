// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
	site: 'https://www.hodi.ba',
	integrations: [mdx(), sitemap()],
	prefetch: true,
	image: {
		service: {
			entrypoint: 'astro/assets/services/sharp'
		}
	}
});
