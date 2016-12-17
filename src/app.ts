import {Game, Match, Metadata, schema, flatbuffers} from 'battlecode-playback';
import * as config from './config';
import * as imageloader from './imageloader';

import Controls from './controls';
import NextStep from './nextstep';
import Renderer from './renderer';
import Stats from './stats';
import TickCounter from './fps';

/**
 * The entrypoint to the battlecode client.
 *
 * We "mount" the application at a particular HTMLElement - everything we create
 * on the page will live as a child of that element.
 *
 * We return a Client, which the web page can use to talk to the running client.
 * It can pause it, make it switch matches, etc.
 *
 * This architecture makes it easy to reuse the client on different web pages.
 */
window['battlecode'] = {
  mount: (root: HTMLElement, conf?: any): Client =>
    new Client(root, conf),
  schema: schema,
  flatbuffers: flatbuffers
};

/**
 * The interface a web page uses to talk to a client.
 */
export default class Client {
  readonly conf: config.Config;
  readonly root: HTMLElement;
  readonly ctx: CanvasRenderingContext2D;

  imgs: imageloader.AllImages;

  controls: Controls;
  stats: Stats;

  canvas: HTMLCanvasElement;

  currentGame: Game | null;

  // used to cancel the main loop
  loopID: number | null;

  constructor(root: HTMLElement, conf?: any) {
    console.log('Battlecode client loading...');

    this.root = root;
    this.conf = config.defaults(conf);

    this.loadRootStyle();

    this.root.appendChild(this.loadGameArea());
    this.root.appendChild(this.loadControls());

    imageloader.loadAll(conf, (images: imageloader.AllImages) => {
      this.imgs = images;
      this.root.appendChild(this.loadStats());
      this.ready();
    });
  }

  /**
   * Sets css of root element and load fonts
   */
  loadRootStyle() {
    this.root.style.fontFamily = "tahoma, sans-serif";
    this.root.style.fontSize = "14px";
    this.root.style.width = "100%";
    this.root.style.height = "100%";
    this.root.style.margin = "0px";

    // Bungee font
    let fonts: HTMLLinkElement = document.createElement("link");
    fonts.setAttribute("href", "https://fonts.googleapis.com/css?family=Bungee");
    fonts.setAttribute("rel", "stylesheet");
    this.root.appendChild(fonts);
  }

  /**
   * Loads canvas to display game world.
   */
  loadGameArea() {
    let gameArea: HTMLDivElement = document.createElement("div");
    // Positioning
    gameArea.style.width = "100%";
    gameArea.style.height = "100%";
    gameArea.style.zIndex = "0.1";
    gameArea.style.position = "fixed";
    gameArea.style.top = "60px";
    gameArea.style.left = "320px";
    // Style
    gameArea.style.background = "#444"
    gameArea.style.background = "-webkit-linear-gradient(#ccc, #444)"
    gameArea.style.background = "-o-linear-gradient(#ccc, #444)"
    gameArea.style.background = "-moz-linear-gradient(#ccc, #444)"
    gameArea.style.background = "linear-gradient(#ccc, #444)"

    let canvasWrapper: HTMLDivElement = document.createElement("div");
    canvasWrapper.style.display = "block";
    canvasWrapper.style.textAlign = "center";
    canvasWrapper.style.paddingRight = "320px";

    let canvas: HTMLCanvasElement = document.createElement('canvas');
    canvas.setAttribute("id", "battlecode-canvas");
    canvas.setAttribute("style", "border: 1px solid black");
    canvas.setAttribute("width", `${this.conf.width}`);
    canvas.setAttribute("height", `${this.conf.height}`);
    this.canvas = canvas;

    gameArea.appendChild(canvasWrapper);
    canvasWrapper.appendChild(canvas);
    return gameArea;
  }

  /**
   * Loads control bar and timeline
   */
  loadControls() {
    this.controls = new Controls();
    return this.controls.div;
  }

  /**
   * Loads stats bar with team information
   */
  loadStats() {
    let teamNames: string[] = ["Chicken Pad Thai", "Vegetable Fried Rice"];
    this.stats = new Stats(teamNames, this.imgs);
    this.stats.setRobotCount(0, "archon", 25);
    return this.stats.div;
  }

  /**
   * Marks the client as fully loaded.
   */
  ready() {
    this.controls.onGameLoaded = (data: ArrayBuffer) => {
      const wrapper = schema.GameWrapper.getRootAsGameWrapper(
        new flatbuffers.ByteBuffer(new Uint8Array(data))
      );
      this.currentGame = new Game();
      this.currentGame.loadFullGame(wrapper);

      this.runMatch();
    }
  }

  private runMatch() {
    // TODO(jhgilles): this is a mess

    console.log('Running match.');

    // Cancel previous games if they're running
    if (this.loopID !== null) {
      window.cancelAnimationFrame(this.loopID);
      this.loopID = null;
    }

    // For convenience
    const game = this.currentGame as Game;
    const meta = game.meta as Metadata;
    const match = game.getMatch(0) as Match;

    // keep around to avoid reallocating
    const nextStep = new NextStep();

    // Configure renderer for this match
    // (radii, etc. may change between matches)
    const renderer = new Renderer(this.canvas, this.imgs, this.conf, game.meta as Metadata);

    // How fast the simulation should progress
    let goalUPS = 10;

    // A variety of stuff to track how fast the simulation is going
    let rendersPerSecond = new TickCounter(.5, 100);
    let updatesPerSecond = new TickCounter(.5, 100);

    // The current time in the simulation, interpolated between frames
    let interpGameTime = 0;
    // The time of the last frame
    let lastTime: number | null = null;
    // whether we're seeking
    let externalSeek = false;

    this.controls.onTogglePause = () => {
      goalUPS = goalUPS === 0? 10 : 0;
    };
    this.controls.onToggleForward = () => {
      goalUPS = goalUPS === 10 ? 300 : 10;
    };
    this.controls.onSeek = (turn: number) => {
      externalSeek = true;
      match.seek(turn);
      interpGameTime = turn;
    };

    // The main update loop
    const loop = (curTime) => {
      let delta = 0;
      if (lastTime === null) {
        // first simulation step
        // do initial stuff?
      } else if (externalSeek) {
        if (match.current.turn === match.seekTo) {
          externalSeek = false;
        }
      } else if (Math.abs(interpGameTime - match.current.turn) < 10) {
        // only update time if we're not seeking
        delta = goalUPS * (curTime - lastTime) / 1000;
        interpGameTime += delta;

        // tell the simulation to go to our time goal
        match.seek(interpGameTime | 0);
      }

      // update fps
      rendersPerSecond.update(curTime, 1);
      updatesPerSecond.update(curTime, delta);
      
      this.controls.setTime(match.current.turn,
                            match['_farthest'].turn,
                            updatesPerSecond.tps,
                            rendersPerSecond.tps);

      // run simulation
      // this may look innocuous, but it's a large chunk of the run time
      match.compute(5 /* ms */);

      lastTime = curTime;

      // only interpolate if:
      // - we want to
      // - we have another frame
      // - we're going slow enough for it to matter
      if (this.conf.interpolate &&
          match.current.turn + 1 < match.deltas.length &&
          goalUPS < rendersPerSecond.tps) {

        nextStep.loadNextStep(
          match.current,
          match.deltas[match.current.turn + 1]
        );

        let lerp = Math.min(interpGameTime - match.current.turn, 1);

        renderer.render(match.current, 
                        match.current.minCorner, match.current.maxCorner.x - match.current.minCorner.x,
                        nextStep, lerp);
      } else {
        // interpGameTime might be incorrect if we haven't computed fast enough
        renderer.render(match.current,
                        match.current.minCorner, match.current.maxCorner.x - match.current.minCorner.x);

      }

      this.loopID = window.requestAnimationFrame(loop);
    };
    this.loopID = window.requestAnimationFrame(loop);
  }
}
