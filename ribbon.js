/* A small, self-contained projected-ribbon renderer. No external dependencies.
 * Its geometry is fitted to the reference silhouette, not the original 3D rig.
 * Public API: await renderer.ready; renderer.draw(seconds); renderer.dispose(). */
class FilmRibbon {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.dark = options.dark || false;
    this.disposed = false;
    this.gl = canvas.getContext('webgl', {
      alpha: false, antialias: true, powerPreference: 'low-power',
      preserveDrawingBuffer: options.preserveDrawingBuffer || false
    });
    this.ready = this.initialize(options.image || 'assets/portraits.webp');
  }
  compile(type, source) {
    const gl = this.gl, shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error);
    }
    return shader;
  }
  program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    const v = this.compile(gl.VERTEX_SHADER, vs), f = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  bezier(points, t) {
    const a = 1 - t;
    return [0, 1].map(k => a*a*a*points[0][k] + 3*a*a*t*points[1][k] + 3*a*t*t*points[2][k] + t*t*t*points[3][k]);
  }
  point(s, v) {
    const front = s <= .7, t = front ? s/.7 : (s-.7)/.3;
    const top = this.bezier(front ? [[-.18,-.13],[.14,.015],[.54,.22],[.80,.33]] : [[.80,.33],[.87,.20],[.96,-.12],[1.04,-.34]], t);
    const bottom = this.bezier(front ? [[-.18,.36],[.18,.58],[.48,.92],[.69,.73]] : [[.69,.73],[.82,.60],[1.14,.40],[1.32,.20]], t);
    return [top[0] + (bottom[0]-top[0])*v, top[1] + (bottom[1]-top[1])*v, s, v];
  }
  async initialize(imageUrl) {
    if (!this.gl) throw new Error('WebGL is unavailable');
    const gl = this.gl;
    this.bg = this.program(`attribute vec2 aPosition; varying vec2 vUV; void main(){gl_Position=vec4(aPosition,0.,1.);vUV=vec2(aPosition.x*.5+.5,.5-aPosition.y*.5);}`, `precision mediump float;
      varying vec2 vUV; uniform vec4 uView; uniform float uEnter;
      void main(){
        vec2 p=vec2((vUV.x-.5)/uView.x+.5,(vUV.y-uView.z)/uView.y);
        float vignette=clamp(length((vUV-vec2(.52,.43))*vec2(1.0,.8)),0.,1.);
        vec3 light=mix(vec3(.935,.936,.918),vec3(.63,.655,.636),vignette*.67);
        vec3 dark=mix(vec3(.14,.155,.145),vec3(.07,.084,.077),vignette*.85);
        float nearest=10.;
        for(int i=0;i<28;i++){
          float t=float(i)/27.,a=1.-t;
          vec2 b=a*a*a*vec2(-.18,.36)+3.*a*a*t*vec2(.18,.58)+3.*a*t*t*vec2(.48,.92)+t*t*t*vec2(.69,.73);
          b+=vec2(0.,.035);
          nearest=min(nearest,length((p-b)*vec2(.60,1.)));
        }
        float shadow=exp(-pow(nearest/.025,2.))*.10*uEnter;
        gl_FragColor=vec4(mix(light,dark,uView.w)-shadow*(1.-uView.w*.6),1.);
      }`);
    this.film = this.program(`attribute vec4 aVertex; varying vec2 vUV; varying float vS; uniform vec4 uView; uniform float uEnter;
      void main(){vec2 p=aVertex.xy;p.x-=1.7*(1.-uEnter);p.y-=.36*(1.-uEnter);p=vec2((p.x-.5)*uView.x+.5,p.y*uView.y+uView.z);gl_Position=vec4(p.x*2.-1.,1.-p.y*2.,0.,1.);vUV=aVertex.zw;vS=aVertex.z;}`, `precision mediump float;
      varying vec2 vUV;varying float vS;uniform sampler2D uAtlas;uniform float uOffset;
      void main(){vec4 pixel=texture2D(uAtlas,vec2(fract(vUV.x*.48-uOffset),vUV.y));if(pixel.a<.03)discard;
        float curl=exp(-pow((vS-.755)/.033,2.));float back=smoothstep(.74,1.,vS);
        vec3 color=pixel.rgb*(1.-.27*back);color=mix(color,vec3(.86,.89,.875),curl*.64);
        gl_FragColor=vec4(color,pixel.a);
      }`);
    this.bgBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bgBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const vertices=[];
    for(let i=219;i>=0;i--) for(let j=0;j<8;j++) {
      const a=i/220,b=(i+1)/220,c=j/8,d=(j+1)/8;
      [this.point(a,c),this.point(a,d),this.point(b,c),this.point(b,c),this.point(a,d),this.point(b,d)].forEach(p=>vertices.push(...p));
    }
    this.filmBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.filmBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);this.count=vertices.length/4;
    this.bgLoc={position:gl.getAttribLocation(this.bg,'aPosition'),view:gl.getUniformLocation(this.bg,'uView'),enter:gl.getUniformLocation(this.bg,'uEnter')};
    this.filmLoc={position:gl.getAttribLocation(this.film,'aVertex'),view:gl.getUniformLocation(this.film,'uView'),enter:gl.getUniformLocation(this.film,'uEnter'),offset:gl.getUniformLocation(this.film,'uOffset'),atlas:gl.getUniformLocation(this.film,'uAtlas')};
    const image = new Image(); image.src=imageUrl; await image.decode();
    if(this.disposed)return;
    this.atlas=this.createAtlas(image);this.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,this.texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,this.atlas);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    this.initialized=true;
  }
  createAtlas(image){
    const atlas=document.createElement('canvas');
    atlas.width=Math.min(4096,this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));atlas.height=512;
    const ctx=atlas.getContext('2d'),scale=atlas.width/4096;ctx.scale(scale,1);
    for(let i=0;i<8;i++){
      const x=i*512;ctx.fillStyle='#242626';ctx.fillRect(x,0,512,512);
      ctx.globalCompositeOperation='destination-out';
      for(let n=0;n<8;n++)for(const y of [17,442]){ctx.beginPath();ctx.roundRect(x+12+n*64,y,38,49,7);ctx.fill();}
      ctx.globalCompositeOperation='source-over';ctx.save();ctx.beginPath();ctx.roundRect(x+17,85,478,340,17);ctx.clip();
      // Each source photograph is one cell of a 4 × 2 contact sheet.
      const sx=(i%4)*image.width/4,sy=Math.floor(i/4)*image.height/2,sw=image.width/4,sh=image.height/2;
      const cropHeight=sw*340/478;ctx.drawImage(image,sx,sy+sh*.04,sw,Math.min(cropHeight,sh),x+17,85,478,340);
      ctx.restore();ctx.fillStyle='#deded3';ctx.textAlign='center';ctx.font='15px monospace';ctx.fillText(String(i+1),x+260,13);ctx.fillText(String(i+1),x+260,508);ctx.font='9px monospace';ctx.fillText('FRAME',x+30,509);ctx.textAlign='left';
    }
    return atlas;
  }
  resize(width,height,dpr=1){
    if(this.disposed)return;
    this.width=width;this.height=height;
    this.canvas.width=Math.round(width*dpr);this.canvas.height=Math.round(height*dpr);
    this.gl.viewport(0,0,this.canvas.width,this.canvas.height);
  }
  draw(seconds, options={}){
    if(!this.initialized||this.disposed)return;
    const gl=this.gl,w=this.width||this.canvas.width,h=this.height||this.canvas.height;
    const mobile=w/h<.9,wide=w/h>2.0;
    const naturalWidth=mobile?Math.max(w,h*.84):(wide?Math.min(w,h*2.35):w);
    const view=[naturalWidth/w,(naturalWidth/1.77778)/h,mobile?.12:.035,this.dark?1:0];
    const p=Math.min(1,Math.max(0,(seconds-.22)/1.1)),enter=options.settled?1:1-Math.pow(1-p,3);
    gl.useProgram(this.bg);gl.bindBuffer(gl.ARRAY_BUFFER,this.bgBuffer);
    gl.enableVertexAttribArray(this.bgLoc.position);gl.vertexAttribPointer(this.bgLoc.position,2,gl.FLOAT,false,0,0);
    gl.uniform4fv(this.bgLoc.view,view);gl.uniform1f(this.bgLoc.enter,enter);gl.drawArrays(gl.TRIANGLES,0,6);gl.disableVertexAttribArray(this.bgLoc.position);
    gl.useProgram(this.film);gl.bindBuffer(gl.ARRAY_BUFFER,this.filmBuffer);
    gl.enableVertexAttribArray(this.filmLoc.position);gl.vertexAttribPointer(this.filmLoc.position,4,gl.FLOAT,false,0,0);
    gl.uniform4fv(this.filmLoc.view,view);gl.uniform1f(this.filmLoc.enter,enter);gl.uniform1f(this.filmLoc.offset,(seconds*.1)%1);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);gl.uniform1i(this.filmLoc.atlas,0);
    gl.drawArrays(gl.TRIANGLES,0,this.count);gl.disableVertexAttribArray(this.filmLoc.position);
  }
  dispose(){
    this.disposed=true;const gl=this.gl;if(!gl)return;
    gl.deleteTexture(this.texture);gl.deleteBuffer(this.bgBuffer);gl.deleteBuffer(this.filmBuffer);gl.deleteProgram(this.bg);gl.deleteProgram(this.film);
  }
}
window.FilmRibbon=FilmRibbon;
