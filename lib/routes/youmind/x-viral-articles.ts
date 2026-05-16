import { load } from 'cheerio';
import pMap from 'p-map';

import type { DataItem, Language, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const rootUrl = 'https://youmind.com';
const routePath = 'landing/x-viral-articles';
const defaultLocale = 'zh-TW';
const supportedLocales = new Set(['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH', 'vi-VN', 'hi-IN', 'es-ES', 'es-419', 'de-DE', 'fr-FR', 'it-IT', 'pt-BR', 'pt-PT', 'tr-TR']);

type SchemaNode = Record<string, any>;

type ListItem = {
    title: string;
    link: string;
    guid: string;
};

export const route: Route = {
    path: '/x-viral-articles/:locale?',
    name: 'X/Twitter Viral Articles Tracking',
    url: 'youmind.com/zh-TW/landing/x-viral-articles',
    maintainers: ['otoitsuki'],
    example: '/youmind/x-viral-articles/zh-TW',
    parameters: {
        locale: 'Locale, defaults to `zh-TW`. Supported values include `en-US`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`, `th-TH`, `vi-VN`, `hi-IN`, `es-ES`, `es-419`, `de-DE`, `fr-FR`, `it-IT`, `pt-BR`, `pt-PT`, and `tr-TR`.',
    },
    categories: ['social-media'],
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportRadar: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['youmind.com/:locale/landing/x-viral-articles', 'youmind.com/landing/x-viral-articles'],
            target: '/youmind/x-viral-articles/:locale',
        },
    ],
    handler,
};

async function handler(ctx) {
    const locale = normalizeLocale(ctx.req.param('locale'));
    const listUrl = getListUrl(locale);
    const response = await ofetch(listUrl);
    const $ = load(response);
    const collectionPage = findSchemaNode(parseJsonLd($), 'CollectionPage');

    const list = getCollectionItems(collectionPage);
    const items = await pMap(
        list,
        (item) =>
            cache.tryGet(item.link, async () => {
                const detailResponse = await ofetch(item.link);
                const $detail = load(detailResponse);
                const schemas = parseJsonLd($detail);
                const article = findSchemaNode(schemas, 'Article');
                const imageObject = findSchemaNode(schemas, 'ImageObject', article?.image?.['@id']);
                const image = getString(article?.thumbnailUrl) ?? getString(imageObject?.url) ?? getString(imageObject?.contentUrl) ?? getMetaContent($detail, 'og:image');
                const description = buildDescription({
                    image,
                    summary: getString(article?.description) ?? getMetaContent($detail, 'description') ?? item.title,
                    sourceLink: getSourceLink($detail, detailResponse),
                });

                return {
                    title: getString(article?.headline) ?? item.title,
                    link: item.link,
                    guid: item.guid,
                    description,
                    pubDate: article?.datePublished ? parseDate(article.datePublished) : undefined,
                    author: getAuthor(article?.author),
                    banner: image,
                    image,
                } satisfies DataItem;
            }),
        { concurrency: 5 }
    );

    return {
        title: $('title').text().trim() || 'X/Twitter Viral Articles Tracking - YouMind',
        description: $('meta[name="description"]').attr('content') || getString(collectionPage?.description),
        link: listUrl,
        language: getFeedLanguage(locale),
        item: items,
    };
}

function normalizeLocale(locale?: string) {
    const value = locale || defaultLocale;

    return supportedLocales.has(value) ? value : defaultLocale;
}

function getListUrl(locale: string) {
    return new URL(`${locale === 'en-US' ? '' : `${locale}/`}${routePath}`, `${rootUrl}/`).href;
}

function getFeedLanguage(locale: string): Language {
    const languageMap: Record<string, Language> = {
        'en-US': 'en-us',
        'zh-CN': 'zh-CN',
        'zh-TW': 'zh-TW',
        'ja-JP': 'ja',
        'ko-KR': 'ko',
        'th-TH': 'other',
        'vi-VN': 'other',
        'hi-IN': 'hi',
        'es-ES': 'es-es',
        'es-419': 'es',
        'de-DE': 'de-de',
        'fr-FR': 'fr-fr',
        'it-IT': 'it-it',
        'pt-BR': 'pt-br',
        'pt-PT': 'pt-pt',
        'tr-TR': 'tr',
    };

    return languageMap[locale] ?? 'zh-TW';
}

function parseJsonLd($: ReturnType<typeof load>) {
    return $('script[type="application/ld+json"]')
        .toArray()
        .flatMap((element) => {
            try {
                return flattenSchema(JSON.parse($(element).text()));
            } catch {
                return [];
            }
        });
}

function flattenSchema(value: any): SchemaNode[] {
    if (!value) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenSchema(item));
    }

    if (typeof value === 'object') {
        const graph = Array.isArray(value['@graph']) ? value['@graph'].flatMap((item) => flattenSchema(item)) : [];

        return [value, ...graph];
    }

    return [];
}

function findSchemaNode(nodes: SchemaNode[], type: string, id?: string) {
    return nodes.find((node) => hasSchemaType(node, type) && (!id || node['@id'] === id));
}

function hasSchemaType(node: SchemaNode, type: string) {
    const nodeType = node['@type'];

    return Array.isArray(nodeType) ? nodeType.includes(type) : nodeType === type;
}

function getCollectionItems(collectionPage?: SchemaNode): ListItem[] {
    const elements = collectionPage?.mainEntity?.itemListElement;

    if (!Array.isArray(elements)) {
        return [];
    }

    return elements
        .map((item) => {
            const link = getString(item.url);
            const title = getString(item.name);

            return link && title
                ? {
                      title,
                      link,
                      guid: link,
                  }
                : undefined;
        })
        .filter((item): item is ListItem => item !== undefined);
}

function getAuthor(author: any) {
    if (Array.isArray(author)) {
        return author
            .map((item) => item.name)
            .filter(Boolean)
            .join(', ');
    }

    return getString(author?.name) ?? getString(author);
}

function getSourceLink($: ReturnType<typeof load>, html: string) {
    const href = $('a[href*="x.com/"][href*="/status/"]').first().attr('href');

    if (href) {
        return href;
    }

    return html.match(/https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/)?.[0];
}

function getMetaContent($: ReturnType<typeof load>, name: string) {
    return $(`meta[name="${name}"]`).attr('content') ?? $(`meta[property="${name}"]`).attr('content') ?? $(`meta[property="og:${name}"]`).attr('content');
}

function buildDescription({ image, summary, sourceLink }: { image?: string; summary?: string; sourceLink?: string }) {
    return [
        image ? `<img src="${escapeHtml(image)}">` : undefined,
        summary ? `<p>${escapeHtml(summary)}</p>` : undefined,
        sourceLink ? `<p>Original X post: <a href="${escapeHtml(sourceLink)}">${escapeHtml(sourceLink)}</a></p>` : undefined,
    ]
        .filter(Boolean)
        .join('');
}

function getString(value: any) {
    return typeof value === 'string' && value ? value : undefined;
}

function escapeHtml(value: string) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
