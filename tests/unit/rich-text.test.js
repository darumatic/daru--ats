import { describe, it, expect } from 'vitest';
import { sanitizeRichTextHtml, hasMeaningfulRichTextContent } from '../../lib/rich-text.js';

describe('sanitizeRichTextHtml', () => {
	describe('XSS payloads stripped', () => {
		it('removes script tags', () => {
			const result = sanitizeRichTextHtml('<p>Hello</p><script>alert(1)</script>');
			expect(result).not.toContain('<script');
			expect(result).toContain('Hello');
		});

		it('removes onerror event handler (HIGH-1 regression)', () => {
			const result = sanitizeRichTextHtml('<img src=x onerror="window.__xss=1">text');
			expect(result).not.toContain('onerror');
			expect(result).not.toContain('__xss');
		});

		it('removes onclick and all on* attributes', () => {
			const result = sanitizeRichTextHtml('<p onclick="steal()">Click me</p>');
			expect(result).not.toContain('onclick');
			expect(result).toContain('Click me');
		});

		it('removes onload on img (img tag stripped entirely, leaving no onload)', () => {
			// img is not in the allowed tag list so it's discarded; result is null (no text content)
			const result = sanitizeRichTextHtml('<img src="x" onload="evil()">');
			// null means the entire payload was discarded — no onload survives
			const asString = result ?? '';
			expect(asString).not.toContain('onload');
		});

		it('removes javascript: href', () => {
			const result = sanitizeRichTextHtml('<a href="javascript:alert(1)">click</a>');
			expect(result).not.toContain('javascript:');
		});

		it('removes iframe tags', () => {
			const result = sanitizeRichTextHtml('<p>text</p><iframe src="evil.com"></iframe>');
			expect(result).not.toContain('<iframe');
		});

		it('removes style tags', () => {
			const result = sanitizeRichTextHtml('<style>body{display:none}</style><p>text</p>');
			expect(result).not.toContain('<style');
			expect(result).toContain('text');
		});

		it('removes object and embed tags', () => {
			const input = '<object data="evil.swf"></object><embed src="evil.swf"><p>text</p>';
			const result = sanitizeRichTextHtml(input);
			expect(result).not.toContain('<object');
			expect(result).not.toContain('<embed');
		});

		it('removes data: URIs in href', () => {
			const result = sanitizeRichTextHtml('<a href="data:text/html,<script>x</script>">link</a>');
			expect(result).not.toContain('data:');
		});

		// The two vectors patched in sanitize-html 2.17.7. Our allowed-tag list
		// never included textarea or svg, but pin the outcome so a downgrade or a
		// widened tag list cannot quietly reopen them.
		it('neutralises the </textarea/> solidus-close mutation XSS (GHSA-jxwj-j7wr-gfrw)', () => {
			const result = sanitizeRichTextHtml('<p>ok</p><textarea></textarea/><script>alert(1)</script>');
			expect(result).toBe('<p>ok</p>');
		});

		it('neutralises the </textarea/> solidus-close carrying an onerror payload', () => {
			const result = sanitizeRichTextHtml('<textarea><p></textarea/><img src=x onerror=alert(1)>');
			expect(result ?? '').not.toContain('onerror');
			expect(result ?? '').not.toContain('<img');
		});

		it('drops SVG SMIL animate elements smuggling a javascript: URI (GHSA-g8qq-57p8-ggw5)', () => {
			const result = sanitizeRichTextHtml(
				'<svg><animate attributeName="href" values="javascript:alert(1)" /></svg>'
			);
			expect(result).toBeNull();
		});

		it('drops SVG SMIL scheme-policy bypass inside a link, keeping only inert text', () => {
			const result = sanitizeRichTextHtml(
				'<p>hi</p><svg><a><animate attributeName="href" values="https://ok.test;javascript:alert(1)"/><text>x</text></a></svg>'
			);
			expect(result).not.toContain('javascript:');
			expect(result).not.toContain('<animate');
			expect(result).not.toContain('href');
		});
	});

	describe('safe HTML preserved', () => {
		it('keeps paragraph tags', () => {
			const result = sanitizeRichTextHtml('<p>Hello world</p>');
			expect(result).toContain('<p>Hello world</p>');
		});

		it('keeps strong and em', () => {
			const result = sanitizeRichTextHtml('<p><strong>Bold</strong> and <em>italic</em></p>');
			expect(result).toContain('<strong>Bold</strong>');
			expect(result).toContain('<em>italic</em>');
		});

		it('keeps ordered and unordered lists', () => {
			const result = sanitizeRichTextHtml('<ul><li>Item A</li><li>Item B</li></ul>');
			expect(result).toContain('<ul>');
			expect(result).toContain('<li>Item A</li>');
		});

		it('keeps headings', () => {
			const result = sanitizeRichTextHtml('<h2>Section Title</h2>');
			expect(result).toContain('<h2>Section Title</h2>');
		});

		it('keeps safe anchor with https href', () => {
			const result = sanitizeRichTextHtml('<a href="https://example.com">Link</a>');
			expect(result).toContain('href="https://example.com"');
		});

		it('keeps blockquote', () => {
			const result = sanitizeRichTextHtml('<blockquote><p>Quote</p></blockquote>');
			expect(result).toContain('<blockquote>');
		});
	});

	describe('edge cases', () => {
		it('returns null for empty string', () => {
			expect(sanitizeRichTextHtml('')).toBeNull();
		});

		it('returns null for null input', () => {
			expect(sanitizeRichTextHtml(null)).toBeNull();
		});

		it('returns null for whitespace only', () => {
			expect(sanitizeRichTextHtml('   ')).toBeNull();
		});

		it('returns null for tags-only with no text content', () => {
			expect(sanitizeRichTextHtml('<p></p>')).toBeNull();
		});

		it('handles undefined input', () => {
			expect(sanitizeRichTextHtml(undefined)).toBeNull();
		});
	});
});

describe('hasMeaningfulRichTextContent', () => {
	it('returns true for text content', () => {
		expect(hasMeaningfulRichTextContent('<p>Hello</p>')).toBe(true);
	});

	it('returns false for empty tags', () => {
		expect(hasMeaningfulRichTextContent('<p></p>')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(hasMeaningfulRichTextContent('')).toBe(false);
	});
});
