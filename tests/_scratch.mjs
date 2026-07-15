// @vitest-environment jsdom
import { describe, it } from 'vitest';

describe('scratch', () => {
  it('event listeners in jsdom', () => {
    let clicked = false;
    document.body.innerHTML = '<button id="b">Click</button>';
    document.getElementById('b').addEventListener('click', () => { clicked = true; });
    document.getElementById('b').click();
    console.log('clicked:', clicked);
  });
});
