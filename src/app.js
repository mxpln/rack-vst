/**
 * Browser half of the page. build.mjs inlines this after `catalog`
 * and the functions of render.js, so all of them are plain globals here.
 */

const state = initialState();
const byId = (id) => document.getElementById(id);

function paintList() {
  const view = listView(catalog, state);
  byId("blogs").innerHTML = view.blogs;
  byId("blogs").hidden = !view.blogs;
  byId("count").innerHTML = view.count;
  byId("list").innerHTML = view.list;
  byId("more").hidden = view.left === 0;
  byId("more").textContent = view.more;
}

function paintChips() {
  for (const button of document.querySelectorAll("[data-filter]")) {
    const { filter, value } = button.dataset;
    const on = filter === "format" ? state.formats.includes(value) : state[filter] === value;
    button.setAttribute("aria-pressed", String(on));
  }
}

function select(id) {
  state.selectedId = id;
  // Only the marker moves: the list is not rebuilt, so keyboard focus stays put.
  for (const button of document.querySelectorAll("[data-plugin]")) {
    button.dataset.selected = String(button.dataset.plugin === id);
  }
  const plugin = catalog.plugins.find((item) => item.id === id);
  const detail = byId("detail");
  detail.dataset.empty = String(!plugin);
  detail.innerHTML = plugin ? detailHtml(plugin) : DETAIL_PLACEHOLDER;
  detail.scrollTop = 0;
  const shot = detail.querySelector(".shot");
  shot?.addEventListener("error", () => shot.remove());
  if (plugin && window.matchMedia("(max-width: 1023px)").matches) {
    detail.scrollIntoView({ block: "start" });
  }
}

function refilter() {
  state.visible = PAGE;
  paintChips();
  paintList();
}

document.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (chip) {
    const { filter, value } = chip.dataset;
    if (filter === "format") {
      state.formats = state.formats.includes(value)
        ? state.formats.filter((format) => format !== value)
        : [...state.formats, value];
    } else {
      state[filter] = value;
    }
    refilter();
    return;
  }
  const plugin = event.target.closest("[data-plugin]");
  if (plugin) select(plugin.dataset.plugin);
  else if (event.target.closest("[data-close]")) select(null);
});

byId("q").addEventListener("input", (event) => {
  state.query = event.target.value;
  refilter();
});

byId("sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  refilter();
});

byId("more").addEventListener("click", () => {
  state.visible += PAGE;
  paintList();
});

// A reload can restore the search box and the sort menu: start from what they show.
state.query = byId("q").value;
state.sort = byId("sort").value;
if (state.query || state.sort !== "stars") paintList();
