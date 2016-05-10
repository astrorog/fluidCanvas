// Initializes 0 velocity fluid of given dimensions and a context to render on
function fluid(width, height, canvas) {
    // Initialize fluid basic properties
    this.width = width;
    this.height = height;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showBack = true;

    // Mouse coordinates
    this.mouseDown = false;
    this.mX = 0;
    this.mY = 0;
    this.dmX = 0;
    this.dmY = 0;

    // Rendered field
    // 0 = concentration, 1 = velocity, 2 = divergence, 3 = pressure, 4 = pressure gradient
    this.renderedField = 0;

    // Initialize rendering buffer
    this.view = this.ctx.createImageData(this.width, this.height);

    // Concentration
    this.c0 = new field(width, height, 1);
    this.c1 = new field(width, height, 1);

    // Marker grid (0 = solid, 1 = liquid, 2 = air)
    this.m0 = new field(width, height, 1);
    this.m1 = new field(width, height, 1);

    // Velocity
    this.v0 = new field(width, height, 2);
    this.v1 = new field(width, height, 2);

    // Extralopated velocity
    this.extV0 = new field(width, height, 2);
    this.extV1 = new field(width, height, 2);

    // Divergence of velocity
    this.div = new field(width, height, 1);

    // Vorticity (Scalar curl of velocity) and its spin direction
    this.vor = new field(width, height, 1);
    this.noise = new field(width, height, 2);
    this.gVor = new field(width, height, 2);
    this.con = new field(width, height, 2);

    // Pressure and its gradient
    // p0 is for scratch calculations; p1 holds the actual values
    this.p0 = new field(width, height, 1);
    this.p1 = new field(width, height, 1);
    this.gp = new field(width, height, 2);

    // Zero out all the fields
    this.c0.fillZero();
    this.c1.fillZero();
    this.div.fillZero();
    this.p0.fillZero();
    this.p1.fillZero();
    this.v0.fillZero();
    this.v1.fillZero();
    this.gp.fillZero();
    this.extV0.fillZero();
    this.extV1.fillZero();

    // Mark solid walls accordingly
    this.m0.updateBoundary(0);
    this.m1.updateBoundary(0);

    // Enforce no slip condition
    this.v0.updateBoundary(0);
    this.v1.updateBoundary(0);

    this.render = function() {
        this.updateView(1.0);
        this.ctx.putImageData(this.view, 0, 0);
    }

    // Sets the mouse coordinates
    this.updateMouse = function(x, y) {
        this.dmX = x - this.mX;
        this.dmY = y - this.mY;
        this.mX = x;
        this.mY = y;
    }

    this.updateView = function(scale) {
        // Choose which field to use to render
        var src = undefined;
        switch(this.renderedField) {
            case 0:
                src = this.showBack ? this.c0: this.c1;
                break;
            case 1:
                src = this.showBack ? this.v0: this.v1;
                break;
            case 2:
                src = this.div;
                break;
            case 3:
                src = this.p1;
                break;
            case 4:
                src = this.gp;
            default:
        }

        // Copy src into the view buffer
        for(var i = 0; i < src.height; i++) {
            for(var j = 0; j < src.width; j++) {
                // Decide mapping based on field type
                if(src.dimension == 2) {
                    var v = src.sample(j + 0.5, i + 0.5);
                    this.updatePixel(j, i, scale * (v.x * v.x + v.y * v.y));
                }
                else {
                    var index = i * src.width + j;
                    this.updatePixel(j, i, scale * Math.abs(src.data[index]));
                }
            }
        }
    }

    this.updatePixel = function(x, y, sat) {
        index = (x + y * this.view.width) * 4;
        this.view.data[index + 0] = 255 * sat;
        this.view.data[index + 1] = 255 * sat;
        this.view.data[index + 2] = 255 * sat;
        this.view.data[index + 3] = 255;
    }

    // Advect an entire field given a dst, src, and vel
    // Offsets are used to deal with staggered grids
    this.advectField = function(dst, src, vel, delta, stencil, offsetX, offsetY) {
        if(dst.dimension == 1) {
            for(var i = 1; i < dst.height - 1; i++) {
                for(var j = 1; j < dst.width - 1; j++) {
                    // Handle liquid boundaries
                    var boundaryType = stencil.getBoundary(j + offsetX, i + offsetY);
                    if(boundaryType == 1 || boundaryType == 3) {
                        this.advect(j + offsetX, i + offsetY, dst, src,
                                    vel, delta, offsetY, offsetX);
                    }
                    else {
                        dst.data[i * dst.width + j] = 0;
                    }
                }
            }
        }
        if(dst.dimension == 2) {
            this.advectField(dst.u, src.u, vel, delta, stencil, 0, 0.5);
            this.advectField(dst.v, src.v, vel, delta, stencil, 0.5, 0);
        }
    }

    // Advects a quantity at (x, y) in src using vel into dst
    this.advect = function(x, y, dst, src, vel, delta, offsetX, offsetY) {
        // Integrate backwards in time by solving for (x0,y0)
        var u = vel.sample(x, y);
        var x0 = x - delta * u.x;
        var y0 = y - delta * u.y;

        // Solve q1(x,y) by interpolating for q0(x0,y0)
        var result = src.sample(x0 + offsetX, y0 + offsetY);
        dst.data[Math.floor(y) * dst.width + Math.floor(x)] = result;
    }

    // Project the given velocity field onto its divergence free component
    // Marker field given to represent free surface
    this.project = function(vel, marker) {
        // Recompute divergence of vel
        vel.divergence(this.div);

        // Use jacobi solver to calculate pressure field
        // Magic numbers taken from the discrete laplacian definition
        this.p1.jacobi(this.p0, this.div, -1, 4, 128, 1.0, marker);

        // Calculate its gradient into gp
        this.p1.gradient(this.gp);

        // Subtract gp from vel
        vel.subtract(this.gp);
    }

    this.step = function() {
        var delta = 0.1;
        var vDst = !this.showBack ? this.v0: this.v1;
        var vSrc = this.showBack ? this.v0: this.v1;

        var cDst = !this.showBack ? this.c0: this.c1;
        var cSrc = this.showBack ? this.c0: this.c1;

        var mDst = !this.showBack ? this.m0: this.m1;
        var mSrc = this.showBack ? this.m0: this.m1;

        // Advect velocity using the velocity field
        this.advectField(vDst, vSrc, vSrc, delta, mSrc, 0, 0);

        // Apply force
        if(this.mouseDown) {
            for(var i = 1; i < this.height - 1; i++) {
                for(var j = 1; j < this.width - 1; j++) {
                    var dx = this.mX - j;
                    var dy = this.mY - i;
                    if(dx * dx + dy * dy < 25) {
                        vDst.u.data[i * vDst.u.width + j] += this.dmX;
                        vDst.v.data[i * vDst.v.width + j] += this.dmY;
                        cSrc.data[i * cDst.width + j] = 1;
                    }
                }
            }
            this.dmX = 0;
            this.dmY = 0;
        }

        // Enforce no-slip condition
        vDst.updateBoundary(0);
        this.project(vDst, mSrc);

        // Apply vorticity confinement and determine arm direction
        vDst.curl(this.vor);
        this.vor.gradient(this.gVor);
        this.gVor.normalize();
        this.con.cross(this.gVor, this.vor);
        this.con.mult(delta);
        vDst.add(this.con);

        // Introduce curl noise
        for(var i = 0; i < this.noise.u.width * this.noise.u.height; i++) {
            this.noise.u.data[i] = Math.random();
        }
        for(var i = 0; i < this.noise.v.width * this.noise.v.height; i++) {
            this.noise.v.data[i] = Math.random();
        }
        this.noise.curl(this.vor);
        this.vor.gradient(this.gVor);
        this.gVor.normalize();
        this.con.cross(this.gVor, this.vor);
        this.con.mult(0.5);
        vDst.add(this.con);

        // Advect concentration using the velocity field
        for(var i = 1; i < this.height - 1; i++) {
            for(var j = 1; j < this.width - 1; j++) {
                // Advect the concentration field
                this.advect(j + 0.5, i + 0.5, cDst, cSrc, vDst, delta, 0, 0);
            }
        }

        this.showBack = !this.showBack;
    }
}

function field(width, height, dimension) {
    this.width = width;
    this.height = height;
    this.dimension = dimension;

    if(dimension == 1) {
        this.data = new Array(width * height);
    }
    if(dimension == 2) {
        this.u = new field(width + 1, height, 1);
        this.v = new field(width, height + 1, 1);
    }

    this.sample = function(x, y) {
        // Anything outside of the inner box is zero
        if(x < 0.5 || x > this.width - 0.5) {return this.zero();}
        if(y < 0.5 || y > this.height - 0.5) {return this.zero();}

        // Sample according to the staggered grid setup
        if(this.dimension == 1) {
            return this.centerSample(x, y);
        }
        if(this.dimension == 2) {
            return this.edgeSample(x, y);
        }
    }

    this.centerSample = function(x, y) {
        var topLeft = Math.round(y - 1) * this.width + Math.round(x - 1);
        var topRight = topLeft + 1;
        var btmLeft = topLeft + this.width;
        var btmRight = btmLeft + 1;

        var kx = x - Math.round(x - 1) - 0.5;
        var ky = y - Math.round(y - 1) - 0.5;

        // Perform a bilerp
        var topVal = this.lerp(kx, this.data[topLeft], this.data[topRight]);
        var btmVal = this.lerp(kx, this.data[btmLeft], this.data[btmRight]);

        return this.lerp(ky, topVal, btmVal);
    }

    this.edgeSample = function(x, y) {
        var result = {x:0, y:0};
        // Sample the u array to get horizontal component
        // Case for which y values are not on the edge of u field
        if(y != 0.5 && y != this.u.height - 0.5) {
            var xu = Math.floor(x) + 0.5;
            var yu = Math.round(y) - 1 + 0.5;
            var kxu = x - Math.floor(x);
            var kyu = y - Math.round(y) + 0.5;

            result.x = this.u.centerSample(xu + kxu, yu + kyu);
        }
        else {
            var l = Math.floor(x);
            var r = l + 1;
            var base = Math.floor(y) * this.u.width;
            var k = x - l;

            result.x = this.u.lerp(k, this.u.data[base + l], this.u.data[base + r]);
        }

        // Sample the v array to get vertical component
        // Case for which x values are not on the edge of v field
        if(x != 0.5 && x != this.v.width - 0.5) {
            var yv = Math.floor(y) + 0.5;
            var xv = Math.round(x) - 1 + 0.5;
            var kxv = x - Math.round(x) + 0.5;
            var kyv = y - Math.floor(y);

            result.y = this.v.centerSample(xv + kxv, yv + kyv);
        }
        else {
            var t = Math.floor(y);
            var base = t * this.v.width + Math.floor(x);
            var k = y - t;

            result.y = this.v.lerp(k, this.v.data[base], this.v.data[base + this.v.width]);
        }

        return result;
    }

    // Calculate the divergence of field into dst
    // Assumes dst is the same size as field
    this.divergence = function(dst) {
        for(var i = 0; i < dst.height; i++) {
            for(var j = 0; j < dst.width; j++) {
                var n = this.v.data[i * this.v.width + j];
                var s = this.v.data[(i + 1) * this.v.width + j];
                var w = this.u.data[i * this.u.width + j];
                var e = this.u.data[i * this.u.width + j + 1];

                dst.data[i * dst.width + j] = (e - w) + (s - n);
            }
        }
    }

    // Calculate the scalar curl of field into dst
    // Assumes dst is the same size as field
    this.curl = function(dst) {
        dst.fillZero();
        for(var i = 1; i < dst.height - 1; i++) {
            for(var j = 1; j < dst.width - 1; j++) {
                var vnw = this.v.data[i * this.v.width + j - 1];
                var vne = this.v.data[i * this.v.width + j + 1];
                var vsw = this.v.data[(i + 1) * this.v.width + j - 1];
                var vse = this.v.data[(i + 1) * this.v.width + j + 1];
                var dvdx = ((vne - vnw) + (vse - vsw)) * 0.25;

                var unw = this.u.data[(i - 1) * this.u.width + j];
                var une = this.u.data[(i - 1) * this.u.width + j + 1];
                var usw = this.u.data[(i + 1) * this.u.width + j];
                var use = this.u.data[(i + 1) * this.u.width + j + 1];
                var dudy = ((usw - unw) + (use - une)) * 0.25;

                dst.data[i * dst.width + j] = dvdx - dudy;
            }
        }
    }

    this.normalize = function() {
        for(var i = 0; i < this.u.height; i++) {
            for(var j = 0; j < this.u.width; j++) {
                var u = this.sample(j, i + 0.5);
                var mag = Math.sqrt(u.x * u.x + u.y * u.y);
                if(mag != 0) {
                    this.u.data[i * this.u.width + j] /= mag;
                }
                else {
                    this.u.data[i * this.u.width + j] = 0;
                }
            }
        }
        for(var i = 0; i < this.v.height; i++) {
            for(var j = 0; j < this.v.width; j++) {
                var u = this.sample(j + 0.5, i);
                var mag = Math.sqrt(u.x * u.x + u.y * u.y);
                if(mag != 0) {
                    this.v.data[i * this.v.width + j] /= mag;
                }
                else {
                    this.v.data[i * this.v.width + j] = 0;
                }
            }
        }
    }

    this.cross = function(left, right) {
        this.fillZero();
        for(var i = 1; i < this.u.height - 1; i++) {
            for(var j = 1; j < this.u.width - 1; j++) {
                var y = left.sample(j, i + 0.5).y;
                var w = right.sample(j, i + 0.5);
                this.u.data[i * this.u.width + j] = y * w;
            }
        }
        for(var i = 1; i < this.v.height - 1; i++) {
            for(var j = 1; j < this.v.width - 1; j++) {
                var x = left.sample(j + 0.5, i).x;
                var w = right.sample(j + 0.5, i);
                this.v.data[i * this.v.width + j] = -1 * x * w;
            }
        }
    }

    // Jacobi iterator using b, alpha, beta, and i iterations to solve into
    // this field. A scratch buffer is provided to minimize memory allocation.
    this.jacobi = function(scratch, b, alpha, beta, i, boundary, marker) {
        // Ensure after i iterations, final result is in this
        var writeScratch = (i % 2) == 0;

        for(var l = 0; l < i; l++) {
            // Reset destination and source
            var dest = writeScratch ? scratch : this;
            var src = writeScratch ? this : scratch;

            // Enforce boundary conditions on outside wall
            dest.updateBoundary(boundary);

            // Enforce boundary conditions for air to liquid boundaries
            for(var i = 0; i < dest.height - 1; i++) {
                for(var j = 0; j < dest.width - 1; j++) {
                    var index = i * dest.height + j;
                    // Where there's air, there's 0 pressure
                    if(marker[index] == 2) {
                        dest.data[index] = 0;
                    }
                }
            }

            // Calculate latest value
            for(var j = 1; j < dest.height - 1; j++) {
                for(var k = 1; k < dest.width - 1; k++) {
                    // Sample neighboring squares from source
                    var index = j * dest.width + k;
                    var w = src.data[index - 1];
                    var n = src.data[index - dest.width];
                    var e = src.data[index + 1];
                    var s = src.data[index + dest.width];

                    // Compute sample from b field
                    var alphaB = b.data[index] * alpha;

                    dest.data[index] = (w + n + e + s + alphaB) / beta;
                }
            }

            // Swap destination and source
            writeScratch = !writeScratch;
        }
    }

    // Calculates the gradient of this field into dst
    this.gradient = function(dst) {
        dst.fillZero();
        // Write into u field
        for(var i = 0; i < dst.u.height; i++) {
            for(var j = 1; j < dst.u.width - 1; j++) {
                var l = this.data[i * this.width + j - 1];
                var r = this.data[i * this.width + j];
                dst.u.data[i * dst.u.width + j] = r - l;
            }
        }
        // Write into v field
        for(var i = 1; i < dst.v.height - 1; i++) {
            for(var j = 0; j < dst.v.width; j++) {
                var n = this.data[(i - 1) * this.width + j];
                var s = this.data[i * this.width + j];
                dst.v.data[i * dst.v.width + j] = s - n;
            }
        }
    }

    // Update boundary values to be the value of closest interior cell scaled by k
    this.updateBoundary = function(k) {
        if(this.dimension == 1) {
            this.updateCenters(k);
        }
        if(this.dimension == 2) {
            this.updateEdges(k);
        }
    }

    // Only applies to marker grid. It returns the interface type at the given coordinate
    // Solid boundary = 0, Liquid boundary = 1, Air to air = 2, Air to liquid = 3
    this.getBoundary = function(x, y) {
        // Horizonal boundary case
        if(y - Math.floor(y) != 0) {
            var r = Math.floor(y) * this.width + Math.floor(x);
            var l = r - 1;
            // This is a solid boundary if there are any solids on interface
            if(this.data[r] == 0 || this.data[l] == 0) {
                return 0;
            }
            // This is an air to air boundary if both sides are air
            if(this.data[r] == 2 && this.data[l] == 2) {
                return 2;
            }
            // This is a air to liquid boundary
            if((this.data[r] == 2 && this.data[l] == 1) ||
               (this.data[r] == 1 && this.data[l] == 2)) {
                return 3;
            }
            // Otherwise this is a purely liquid to liquid interface
            return 1;
        }
        // Vertical boundary case
        if(x - Math.floor(x) != 0) {
            var b = Math.floor(y) * this.width + Math.floor(x);
            var t = b - this.width;
            // This is a solid boundary if there are any solids on interface
            if(this.data[b] == 0 || this.data[t] == 0) {
                return 0;
            }
            // This is an air to air boundary if both sides are air
            if(this.data[b] == 2 && this.data[t] == 2) {
                return 2;
            }
            // This is a air to liquid boundary
            if((this.data[t] == 2 && this.data[b] == 1) ||
               (this.data[t] == 1 && this.data[b] == 2)) {
                return 3;
            }
            // Otherwise this is a purely liquid to liquid interface
            return 1;
        }
    }

    this.updateCenters = function(k) {
        // Update top and bottom rows
        for(var i = 0; i < this.width; i++) {
            this.data[i] = this.scale(k, this.data[i + this.width]);
            var index = (this.height - 1) * this.width + i;
            this.data[index] = this.scale(k, this.data[index - this.width]);
        }
        // Update left and right columns
        for(var i = 0; i < this.height; i++) {
            var index = i * this.width;
            this.data[index] = this.scale(k, this.data[index + 1]);
            index = index + this.width - 1;
            this.data[index] = this.scale(k, this.data[index - 1]);
        }
    }

    this.updateEdges = function(k) {
        // Outer edges of staggered fields are defined to be 0
        this.u.updateCenters(0);
        this.v.updateCenters(0);

        // Update top and bottom rows of v field
        for(var i = 1; i < this.v.width - 1; i++) {
            var index = i + this.v.width;
            this.v.data[index] = k * this.v.data[index + this.width];
            index = (this.v.height - 2) * this.v.width + i;
            this.v.data[index] = k * this.v.data[index - this.width];
        }
        // Update left and right columns of u field
        for(var i = 1; i < this.u.height - 1; i++) {
            var index = i * this.u.width + 1;
            this.u.data[index] = k * this.u.data[index + 1];
            index = i * this.u.width + this.u.width - 2;
            this.u.data[index] = k * this.u.data[index - 1];
        }
    }

    // Calculate (this - other) into this
    this.subtract = function(other) {
        // Loop through and subtract element by element
        if(this.dimension == 1) {
            for(var i = 0; i < this.height; i++) {
                for(var j = 0; j < this.width; j++) {
                    var index = i * this.width + j;
                    this.data[index] = this.data[index] - other.data[index];
                }
            }
        }
        if(this.dimension == 2) {
            this.u.subtract(other.u);
            this.v.subtract(other.v);
        }
    }

    // Calculate (this + other) into this
    this.add = function(other) {
        // Loop through and add element by element
        if(this.dimension == 1) {
            for(var i = 0; i < this.height; i++) {
                for(var j = 0; j < this.width; j++) {
                    var index = i * this.width + j;
                    this.data[index] = this.data[index] + other.data[index];
                }
            }
        }
        if(this.dimension == 2) {
            this.u.add(other.u);
            this.v.add(other.v);
        }
    }

    // Calculate (this * scale) into this
    this.mult = function(scale) {
        // Loop through and multiply each element
        if(this.dimension == 1) {
            for(var i = 0; i < this.height; i++) {
                for(var j = 0; j < this.width; j++) {
                    var index = i * this.width + j;
                    this.data[index] = this.data[index] * scale;
                }
            }
        }
        if(this.dimension == 2) {
            this.u.mult(scale);
            this.v.mult(scale);
        }
    }

    this.scale = function(k, a) {
        if(this.dimension == 1) {
            return k * a;
        }
        if(this.dimension == 2) {
            return {x:k * a.x, y:k * a.y};
        }
    }

    this.extrapolate = function(dst, stencil, scratch) {
        // Initialize dst (the 0th iteration of this extrapolation)
        dst.fillZero();
        for(var i = 1; i < this.u.height - 1; i++) {
            for(var j = 1; j < this.u.width - 1; j++) {
                var boundaryType = stencil.getBoundary(j, i + 0.5);
                // If this velocity is between air or solid cells, set it as NaN
                var index = i * this.u.width + j;
                if(boundaryType == 2 || boundaryType == 0) {
                    dst.u.data[index] = Number.NaN;
                }
                // If this velocity is between liquid cells, extract it from u
                else {
                    dst.u.data[index] = this.u.data[index];
                }
            }
        }
        for(var i = 1; i < this.v.height - 1; i++) {
            for(var j = 1; j < this.v.width - 1; j++) {
                var boundaryType = stencil.getBoundary(j + 0.5, i);
                // If this velocity is between air or solid cells, set it as NaN
                var index = i * this.v.width + j;
                if(boundaryType == 2 || boundaryType == 0) {
                    dst.v.data[index] = Number.NaN;
                }
                // If this velocity is between liquid cells, extract it from u
                else {
                    dst.v.data[index] = this.v.data[index];
                }
            }
        }

        // Propogate numbers through cells 10 times
        var write = dst;
        var read = scratch;
        for(var l = 0; l < 10; l++) {
            write = (write == dst) ? scratch : dst;
            read = (write == dst) ? scratch : dst;
            for(var i = 1; i < this.u.height - 1; i++) {
                for(var j = 1; j < this.u.width - 1; j++) {
                    var index = i * this.u.width + j;
                    if(isNaN(read.u.data[index])) {
                        var n = read.u.data[index - this.u.width];
                        var s = read.u.data[index + this.u.width];
                        var e = read.u.data[index + 1];
                        var w = read.u.data[index - 1];

                        // Count number of valid neighbors
                        var k = 0;
                        if(!isNaN(n)) k++;
                        if(!isNaN(s)) k++;
                        if(!isNaN(e)) k++;
                        if(!isNaN(w)) k++;

                        // If 0, do nothing and set it as NaN
                        if(k == 0) {
                            write.u.data[index] = Number.NaN;
                        }
                        // If not 0, set value to average
                        else {
                            n = (isNaN(n)) ? 0 : n;
                            s = (isNaN(s)) ? 0 : s;
                            e = (isNaN(e)) ? 0 : e;
                            w = (isNaN(w)) ? 0 : w;
                            write.u.data[index] = (n + s + w + e) / k;
                        }
                    }
                    else {
                        write.u.data[index] = read.u.data[index];
                    }
                }
            }
            for(var i = 1; i < this.v.height - 1; i++) {
                for(var j = 1; j < this.v.width - 1; j++) {
                    var index = i * this.v.width + j;
                    if(isNaN(read.v.data[index])) {
                        var n = read.v.data[index - this.v.width];
                        var s = read.v.data[index + this.v.width];
                        var e = read.v.data[index + 1];
                        var w = read.v.data[index - 1];

                        // Count number of valid neighbors
                        var k = 0;
                        if(!isNaN(n)) k++;
                        if(!isNaN(s)) k++;
                        if(!isNaN(e)) k++;
                        if(!isNaN(w)) k++;

                        // If 0, do nothing and set it as NaN
                        if(k == 0) {
                            write.v.data[index] = Number.NaN;
                        }
                        // If not 0, set value to average
                        else {
                            n = (isNaN(n)) ? 0 : n;
                            s = (isNaN(s)) ? 0 : s;
                            e = (isNaN(e)) ? 0 : e;
                            w = (isNaN(w)) ? 0 : w;
                            write.v.data[index] = (n + s + w + e) / k;
                        }
                    }
                    else {
                        write.v.data[index] = read.v.data[index];
                    }
                }
            }
        }
        dst.updateBoundary(0);
    }

    this.zero = function() {
        if(this.dimension == 1)
            return 0;
        else if(this.dimension == 2)
            return {x:0, y:0};
    }

    this.lerp = function(k, a, b) {
        if(this.dimension == 1) {
            return (1 - k) * a + (k) * b;
        }
        if(this.dimension == 2) {
            var x = (1 - k) * a.x + (k) * b.x;
            var y = (1 - k) * a.y + (k) * b.y;
            return {x:x, y:y};
        }
    }

    this.fillZero = function() {
        if(dimension == 1) {
            for(var i = 0; i < this.height; i++) {
                for(var j = 0; j < this.width; j++) {
                    var index = i * this.width + j;
                    this.data[index] = 0;
                }
            }
        }

        if(dimension == 2) {
            this.u.fillZero();
            this.v.fillZero();
        }
    }
}
