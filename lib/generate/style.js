'use strict';
/**
 * The house style spec - one shared token table every archetype and every
 * renderer reads from. Reverse-engineered from the two Alex-approved
 * sample documents' actual styles.xml (see
 * scope/docs/document-generation-canon.md §2), not invented. Changing the
 * house look means editing this file once - nothing else hardcodes a
 * font, size, or color.
 *
 * Plain data, no logic - trivially diffable if the look ever needs to
 * change, and usable identically by the docx/markdown/pdf renderers
 * despite each format expressing "bold, 15pt, navy" completely
 * differently.
 */

const style = {
  font: { family: 'Calibri' },

  h1: { size: 15, bold: true, color: '1F3864' },        // document title
  h2: { size: 8.5, bold: true, color: '2F5496', borderColor: 'B4C6E7' }, // section headings
  body: { size: 9 },                                      // paragraphs, bullets
  meta: { size: 7.5, color: '808080' },                    // meta line, footer notes

  page: {
    size: 'A4',
    widthTwips: 11906, heightTwips: 16838,
    marginTopTwips: 737, marginBottomTwips: 737,
    marginLeftTwips: 907, marginRightTwips: 907,
    headerTwips: 720, footerTwips: 720,
  },

  spacing: {
    bodyAfterTwips: 70, bodyLine: 1.14,
    h2BeforeTwips: 140, h2AfterTwips: 40,
  },
};

module.exports = { style };
