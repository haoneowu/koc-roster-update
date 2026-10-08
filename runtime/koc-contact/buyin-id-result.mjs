const normalizeCell = value => String(value ?? '').replace(/\s+/g, '').trim();
const ID_HEADERS = new Set(['抖音号', '抖音ID', '达人ID', '达人抖音号']);

// Inspect the visible Buyin result table in-page and return only fixed facts.
// Do not return nicknames, row contents, or the ID value itself to the caller.
export async function inspectVisibleBuyinIdRows(page, expectedId, searchPlaceholder = '',
  {includeProfileHref = false,includeContactMarker = false,expectedUid = ''} = {}) {
  return page.evaluate(({id,expectedUid,searchPlaceholder,includeProfileHref,includeContactMarker}) => {
    const normalize = value => String(value ?? '').replace(/\s+/gu, '').trim();
    const idHeaders = new Set(['抖音号','抖音ID','达人ID','达人抖音号']);
    const visible = element => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
    const positiveContactLabels = ['有联系方式','查看过联系方式','已查看联系方式'];
    const contactWords = /联系|微信|电话/u;
    const semanticContactAttributes = /^(?:data-[\w-]*(?:contact|wechat|wx|phone)[\w-]*|aria-label|title)$/iu;
    const contactMarkerFor = element => {
      let present = false;
      let unresolved = false;
      const sources = new Set();
      const attributeNames = new Set();
      for (const node of [element,...element.querySelectorAll('*')]) {
        if (!visible(node)) continue;
        const text = normalize(node.innerText || node.textContent);
        if (text && positiveContactLabels.some(label => text.includes(label))) {
          present = true;
          sources.add('visible_text');
        } else if (node.children.length === 0 && contactWords.test(text)) {
          unresolved = true;
        }
        for (const name of ['aria-label','title']) {
          const value = normalize(node.getAttribute(name));
          if (!value) continue;
          if (positiveContactLabels.some(label => value.includes(label))) {
            present = true;
            sources.add(name.replace('-','_'));
          } else if (contactWords.test(value)) {
            unresolved = true;
            attributeNames.add(name);
          }
        }
        for (const name of node.getAttributeNames()) {
          if (!semanticContactAttributes.test(name) || name === 'aria-label' || name === 'title') continue;
          attributeNames.add(name);
          // A data attribute's name/value alone does not prove that it means
          // "contact information is available". Keep it unresolved until its
          // rendered semantics are independently established.
          unresolved = true;
        }
      }
      return {present,unresolved:!present&&unresolved,
        state:present?'present':unresolved?'unresolved':'absent',
        sources:[...sources],attributeNames:[...attributeNames].sort()};
    };
    const cells = row => [...row.children].filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD' ||
      cell.getAttribute('role') === 'columnheader' || cell.getAttribute('role') === 'cell');
    const profileLinksFor = element => [
      ...(element.matches?.('a') ? [element] : []), ...element.querySelectorAll('a'),
    ].filter(link => {
      if (!visible(link)) return false;
      try {
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && /\/dashboard\/servicehall\/daren-profile(?:\/|$)/u.test(url.pathname);
      } catch { return false; }
    }).map(link => link.href);
    const contactLabelPresentFor = element => contactMarkerFor(element).present;
    const includeHrefFacts = (base, matches) => {
      const unique = matches.length === 1 ? matches[0] : null;
      const hrefs = unique?.profileHrefs ?? [];
      if (!includeProfileHref && !includeContactMarker) return base;
      return {
        ...base,
        ...(includeProfileHref ? {detailLinkCount:hrefs.length,
          ...(hrefs.length === 1 ? {detailHref:hrefs[0]} : {})} : {}),
        ...(includeProfileHref || includeContactMarker
          ? {contactLabelPresent:unique?.contactLabelPresent === true} : {}),
        ...(includeContactMarker && unique?.contactMarker
          ? {contactMarkerState:unique.contactMarker.state,
            contactMarkerSources:unique.contactMarker.sources,
            contactMarkerAttributeNames:unique.contactMarker.attributeNames} : {}),
      };
    };
    let idHeaderFound = false;
    let tableMatches = 0;
    const tableMatchedRows = [];
    for (const table of document.querySelectorAll('table,[role="table"]')) {
      if (!visible(table)) continue;
      const rows = [...table.querySelectorAll('tr,[role="row"]')].filter(visible);
      const headerRows = rows.filter(row => cells(row).some(cell =>
        cell.tagName === 'TH' || cell.getAttribute('role') === 'columnheader'));
      for (const headerRow of headerRows) {
        const headerCells = cells(headerRow).filter(visible);
        const targetColumns = headerCells.flatMap((cell,index) =>
          idHeaders.has(normalize(cell.innerText || cell.textContent)) ? [index] : []);
        if (targetColumns.length !== 1) continue;
        idHeaderFound = true;
        const idColumn = targetColumns[0];
        for (const row of rows) {
          if (row === headerRow) continue;
          const rowCells = cells(row).filter(visible);
          if (normalize(rowCells[idColumn]?.innerText || rowCells[idColumn]?.textContent) === normalize(id)) {
            tableMatches++;
            const contactMarker=contactMarkerFor(row);
            tableMatchedRows.push({profileHrefs:profileLinksFor(row),contactLabelPresent:contactMarker.present,contactMarker});
          }
        }
      }
    }
    const searchInput = searchPlaceholder ? [...document.querySelectorAll('input')].find(element =>
      visible(element) && element.getAttribute('placeholder') === searchPlaceholder) : null;
    const exactLeaves = [...document.querySelectorAll('*')].filter(element => visible(element) &&
      element.children.length === 0 && normalize(element.innerText || element.textContent) === normalize(id));
    // Keep query echoes and autocomplete options inside the actual search widget.
    // A broad page/form ancestor that also contains the result list is not a
    // search scope. aria-controls/owns covers portaled suggestion lists.
    const searchScopes = new Set();
    const hasVisibleResultStructure = element => {
      if ([...element.querySelectorAll('table,[role="table"],tr,[role="row"]')].some(child => visible(child))) return true;
      return [...element.querySelectorAll('a')].some(link => {
        if (!visible(link)) return false;
        try {
          const url = new URL(link.href, location.href);
          return url.origin === location.origin && /\/dashboard\/servicehall\/daren-profile(?:\/|$)/u.test(url.pathname);
        } catch { return false; }
      });
    };
    if (searchInput) {
      searchScopes.add(searchInput);
      const controlledIds = `${searchInput.getAttribute('aria-controls') || ''} ${searchInput.getAttribute('aria-owns') || ''}`
        .trim().split(/\s+/u).filter(Boolean);
      for (const id of controlledIds) {
        const controlled = document.getElementById(id);
        if (controlled && visible(controlled)) searchScopes.add(controlled);
      }
      for (let ancestor = searchInput.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const className = typeof ancestor.className === 'string' ? ancestor.className : '';
        const searchWidget = ancestor.matches('form,[role="search"],[role="combobox"]') ||
          /(?:^|[-_\s])(?:search|select|autocomplete|auto-complete)(?:$|[-_\s])/iu.test(className);
        if (searchWidget && !hasVisibleResultStructure(ancestor)) searchScopes.add(ancestor);
      }
      // Portaled autocomplete dropdowns often expose option/listbox semantics
      // without being descendants of the input wrapper.
      for (const option of document.querySelectorAll('[role="option"],[role="listbox"]')) {
        if (visible(option) && !hasVisibleResultStructure(option)) searchScopes.add(option);
      }
    }
    const isInsideSearchControl = element => [...searchScopes].some(scope => scope === element || scope.contains(element));
    const exactLeavesInSearch = exactLeaves.filter(isInsideSearchControl);
    const exactLeavesOutsideSearch = exactLeaves.filter(element => !isInsideSearchControl(element));
    const semanticRows = [...document.querySelectorAll('tr,[role="row"],li,[role="listitem"],article,[role="article"]')]
      .filter(visible).filter(element => !isInsideSearchControl(element))
      .filter(element => ![...element.querySelectorAll('tr,[role="row"],li,[role="listitem"],article,[role="article"]')]
        .some(child => visible(child) && !isInsideSearchControl(child)));
    const identityAttributeNames = ['data-row-key','data-key','data-id','data-uid','id'];
    const expectedUidText = normalize(expectedUid);
    const expectedIdText = normalize(id);
    const identityRows = [];
    if (expectedUidText) {
      for (const row of semanticRows) {
        const keyKinds = new Set();
        const matchedAttributes = new Set();
        for (const name of identityAttributeNames) {
          const value = normalize(row.getAttribute(name));
          if (value && value === expectedUidText) { keyKinds.add('UID'); matchedAttributes.add(name); }
          if (value && value === expectedIdText) { keyKinds.add('AWEME_ID'); matchedAttributes.add(name); }
        }
        const linkKeys = new Set();
        const links = [...(row.matches?.('a') ? [row] : []),...row.querySelectorAll('a')].filter(visible);
        for (const link of links) {
          try {
            const url = new URL(link.href, location.href);
            if (url.origin !== location.origin) continue;
            for (const key of ['uid','aweme_id','author_id','id']) {
              const value = normalize(url.searchParams.get(key));
              if (value && value === expectedUidText) { keyKinds.add('UID'); linkKeys.add(key); }
              if (value && value === expectedIdText) { keyKinds.add('AWEME_ID'); linkKeys.add(key); }
            }
          } catch { /* Ignore malformed or inaccessible links. */ }
        }
        if (keyKinds.size) {
          identityRows.push({keyKinds:[...keyKinds].sort(),matchedAttributes:[...matchedAttributes].sort(),
            linkKeys:[...linkKeys].sort(),profileHrefs:profileLinksFor(row),
            contactMarker:contactMarkerFor(row),contactLabelPresent:contactMarkerFor(row).present});
        }
      }
    }
    if (identityRows.length > 1) {
      return includeHrefFacts({idHeaderFound,exactMatches:identityRows.length,exactIdTextCount:exactLeaves.length,
        searchControlIdTextCount:exactLeavesInSearch.length,candidateResultCardCount:identityRows.length,
        candidateProfileLinkCount:identityRows.reduce((total,row)=>total+row.profileHrefs.length,0),
        resultStructure:'AMBIGUOUS_ID'},identityRows);
    }
    if (identityRows.length === 1) {
      const row = identityRows[0];
      return includeHrefFacts({idHeaderFound,exactMatches:1,exactIdTextCount:exactLeaves.length,
        searchControlIdTextCount:exactLeavesInSearch.length,candidateResultCardCount:1,
        candidateProfileLinkCount:row.profileHrefs.length,resultStructure:'STABLE_KEY_ROW',
        matchedIdentityKeyKind:row.keyKinds.length===2?'BOTH':row.keyKinds[0],
        matchedIdentityAttributeNames:row.matchedAttributes,matchedIdentityHrefParamNames:row.linkKeys},[row]);
    }
    const signature = element => [...element.children].map(child =>
      `${child.tagName}:${child.getAttribute('role') || ''}:${getComputedStyle(child).display}`).join('|');
    const profileLinkCountFor = element => profileLinksFor(element).length;
    const safeBusinessActions = new Set(['查看主页','查看达人主页','达人详情','进入主页','抖音主页']);
    const actionCountFor = element => [
      ...(element.matches?.('button,a,[role="button"]') ? [element] : []),
      ...element.querySelectorAll('button,a,[role="button"]'),
    ].filter(control =>
      visible(control) && safeBusinessActions.has(normalize(control.getAttribute('aria-label') || control.innerText))).length;
    const exactResultCards = [];
    for (const leaf of exactLeavesOutsideSearch) {
      let selected = null;
      const insideSemanticTable = Boolean(leaf.closest('table,[role="table"],tr,[role="row"]'));
      for (let ancestor = leaf; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        if (isInsideSearchControl(ancestor)) break;
        const profileLinkCount = profileLinkCountFor(ancestor);
        const actionCount = actionCountFor(ancestor);
        const siblingCandidates = !insideSemanticTable && ancestor.parentElement
          ? [...ancestor.parentElement.children].filter(sibling => visible(sibling) &&
              sibling.tagName === ancestor.tagName && sibling.getAttribute('role') === ancestor.getAttribute('role'))
          : [];
        const sameShapeCount = siblingCandidates.filter(sibling => signature(sibling) === signature(ancestor)).length;
        const sameCardExactIdCount = exactLeavesOutsideSearch.filter(candidate => ancestor.contains(candidate)).length;
        const repeatedListItem = sameShapeCount > 1 && ancestor.children.length > 1 &&
          ancestor.matches('li,[role="listitem"],article,[role="article"]');
        if (sameCardExactIdCount === 1 && (profileLinkCount > 0 || actionCount > 0 || repeatedListItem)) {
          const contactMarker=contactMarkerFor(ancestor);
          selected = {profileLinkCount,actionCount,profileHrefs:profileLinksFor(ancestor),
            contactLabelPresent:contactMarker.present,contactMarker};
          break;
        }
      }
      if (selected) exactResultCards.push(selected);
    }
    const candidateResultCardCount = exactResultCards.length;
    const candidateProfileLinkCount = exactResultCards.reduce((total,card) => total + card.profileLinkCount,0);
    if (idHeaderFound) {
      const resultStructure = tableMatches > 1 ? 'AMBIGUOUS_ID' :
        tableMatches === 1 ? 'TABLE_ID_COLUMN' : 'TABLE_ID_NO_MATCH';
      return includeHrefFacts({idHeaderFound,exactMatches:tableMatches,exactIdTextCount:exactLeaves.length,
        searchControlIdTextCount:exactLeavesInSearch.length,candidateResultCardCount,candidateProfileLinkCount,resultStructure,
        ...(tableMatches===1?{matchedIdentityKeyKind:'AWEME_ID',matchedIdentitySource:'VISIBLE_AWEME_ID'}:{})},tableMatchedRows);
    }
    if (candidateResultCardCount > 0) {
      const resultStructure = candidateResultCardCount === 1 ? 'FORMAL_RESULT_CARD' : 'AMBIGUOUS_ID';
      return includeHrefFacts({idHeaderFound,exactMatches:candidateResultCardCount,exactIdTextCount:exactLeaves.length,
        searchControlIdTextCount:exactLeavesInSearch.length,candidateResultCardCount,candidateProfileLinkCount,resultStructure,
        ...(candidateResultCardCount===1?{matchedIdentityKeyKind:'AWEME_ID',matchedIdentitySource:'VISIBLE_AWEME_ID'}:{})},exactResultCards);
    }
    const resultStructure = exactLeavesInSearch.length ? 'QUERY_CONTROL_ONLY' :
      exactLeavesOutsideSearch.length ? 'UNCLASSIFIED_ID_CONTAINER' : 'NO_EXACT_ID_TEXT';
    return includeHrefFacts({idHeaderFound,exactMatches:0,exactIdTextCount:exactLeaves.length,
      searchControlIdTextCount:exactLeavesInSearch.length,candidateResultCardCount,candidateProfileLinkCount,resultStructure},[]);
  }, {id:expectedId,expectedUid,searchPlaceholder,includeProfileHref,includeContactMarker});
}

// Return the sole visible result row whose explicit Douyin-ID column exactly
// matches the query. Nickname values intentionally do not participate.
export function findUniqueBuyinIdRow(tables, expectedId) {
  const id = normalizeCell(expectedId);
  if (!id || !Array.isArray(tables)) return null;

  const matches = [];
  tables.forEach((table, tableIndex) => {
    const headers = Array.isArray(table?.headers) ? table.headers.map(normalizeCell) : [];
    const idColumns = headers.flatMap((header, index) => ID_HEADERS.has(header) ? [index] : []);
    if (idColumns.length !== 1 || !Array.isArray(table?.rows)) return;
    const idColumn = idColumns[0];
    for (const row of table.rows) {
      if (row?.visible !== true || !Array.isArray(row.cells)) continue;
      if (normalizeCell(row.cells[idColumn]) === id) {
        matches.push({tableIndex, rowIndex: row.index});
      }
    }
  });
  return matches.length === 1 ? matches[0] : null;
}
