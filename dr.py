#!/usr/bin/env python3
"""
dr.py – All-in-one DR runner + dynamic metadata generator.

• Supports listing methods, subset strategies, and per-method param schemas.
• Runs any algorithm in ALGOS, upserts configs, saves points, then emits JSON.
• Uses Python 3.13 argparse with mutually exclusive flags.
"""

import argparse, json, sys, time, warnings
from typing import Any
import numpy as np           # numeric core
import db                     # our db.py layer

# Configure warnings to go to stderr instead of stdout
warnings.filterwarnings("ignore", category=FutureWarning, module="sklearn")
warnings.filterwarnings("ignore", category=UserWarning)

# Redirect print statements to stderr to avoid interfering with JSON output
original_print = print
def print_to_stderr(*args, **kwargs):
    kwargs['file'] = sys.stderr
    original_print(*args, **kwargs)

# We'll use this function for JSON output to ensure it goes to stdout
def print_json(data):
    original_print(json.dumps(data), file=sys.stdout)
    sys.stdout.flush()

# Replace the built-in print with our stderr version for normal messages
print = print_to_stderr

# ───────────────────────────────────────────────────────────────
# 1) Algorithm registry
# ───────────────────────────────────────────────────────────────
def umap(X, **cfg):
    try:
        import umap
        # Ensure n_components has a default value if not provided
        if "n_components" not in cfg:
            cfg["n_components"] = 2
            
        # Handle deprecated parameters
        cfg = _handle_deprecated_params(cfg)
            
        return umap.UMAP(**cfg).fit_transform(X)
    except ImportError:
        raise ImportError("UMAP package is not installed. Please install it with: pip install umap-learn")

def tsne(X, **cfg):
    try:
        from openTSNE import TSNE
        # Ensure n_components has a default value if not provided
        if "n_components" not in cfg:
            cfg["n_components"] = 2
            
        # Handle deprecated parameters
        cfg = _handle_deprecated_params(cfg)
            
        return TSNE(**cfg).fit(X)
    except ImportError:
        # Fallback to sklearn's TSNE if openTSNE is not available
        try:
            from sklearn.manifold import TSNE as SklearnTSNE
            print("Warning: Using sklearn's TSNE instead of openTSNE")
            if "n_components" not in cfg:
                cfg["n_components"] = 2
                
            # Handle deprecated parameters
            cfg = _handle_deprecated_params(cfg)
                
            return SklearnTSNE(**cfg).fit_transform(X)
        except ImportError:
            raise ImportError("Neither openTSNE nor sklearn's TSNE are installed. Please install one of them.")
        except Exception as e:
            raise Exception(f"Error using sklearn's TSNE: {str(e)}")

def phate(X, **cfg):
    try:
        import phate
        # Ensure n_components has a default value if not provided
        if "n_components" not in cfg:
            cfg["n_components"] = 2
        return phate.PHATE(**cfg).fit_transform(X)
    except ImportError:
        # Fallback to UMAP if phate is not available
        try:
            print("Warning: PHATE package not found, falling back to UMAP")
            # Create a copy of cfg to avoid modifying the original
            umap_cfg = cfg.copy()
            
            # Remove PHATE-specific parameters that UMAP doesn't support
            if "knn" in umap_cfg:
                n_neighbors = umap_cfg.pop("knn")
                umap_cfg["n_neighbors"] = n_neighbors  # Use as n_neighbors in UMAP
            if "decay" in umap_cfg:
                umap_cfg.pop("decay")  # No equivalent in UMAP
                
            return umap(X, **umap_cfg)
        except Exception as e:
            raise ImportError(f"PHATE package is not installed and fallback to UMAP failed: {str(e)}. Please install PHATE with: pip install phate")
def pacmap(X, **cfg):
    try:
        import pacmap
        from sklearn.decomposition import PCA
        Xp = PCA(n_components=min(25, X.shape[1])).fit_transform(X.astype(np.float32))
        
        # Set default values for parameters if not provided
        defaults = {
            "n_components": 2,
            "n_neighbors": 10,
            "num_iters": 450,
            "lr": 1.0,
            "MN_ratio": 0.5,
            "FP_ratio": 2.0,
            "apply_pca": True,
            "preprocess_pca": 50,
            "backend": "annoy",
            "verbose": False
        }
        
        # Apply defaults for missing parameters
        for key, value in defaults.items():
            if key not in cfg:
                cfg[key] = value
                
        return pacmap.PaCMAP(**cfg).fit_transform(Xp, init="random")
    except ImportError:
        # Fallback to UMAP if pacmap is not available
        try:
            print("Warning: PaCMAP package not found, falling back to UMAP")
            return umap(X, **cfg)
        except Exception as e:
            raise ImportError(f"PaCMAP package is not installed and fallback to UMAP failed: {str(e)}. Please install PaCMAP with: pip install pacmap")

def spacemap(X, **cfg):
    try:
        from spacemap import SpaceMAP
        
        # Set default values for parameters if not provided
        defaults = {
            "n_near_field": 21,
            "n_middle_field": 50,
            "eta": 0.6,
            "n_epochs": 200,
            "n_components": 2,
            "d_local": 0,
            "d_global": 4.5,
            "init": "spectral",
            "metric": "euclidean",
            "plot_results": False,
            "num_plots": 0,
            "verbose": True
        }
        
        # Apply defaults for missing parameters
        for key, value in defaults.items():
            if key not in cfg:
                cfg[key] = value
        
        # X needs to be passed separately as it's not part of the config
        return SpaceMAP(X=X, **cfg).fit_transform(X)
    except ImportError:
        # Fallback to UMAP if spacemap is not available
        try:
            print("Warning: SpaceMAP package not found, falling back to UMAP")
            return umap(X, **cfg)
        except Exception as e:
            raise ImportError(f"SpaceMAP package is not installed and fallback to UMAP failed: {str(e)}. Please install SpaceMAP with: pip install spacemap")

def trimap(X, **cfg):
    try:
        import trimap
        # Ensure n_components has a default value if not provided
        if "n_components" not in cfg:
            cfg["n_components"] = 2
        return trimap.TRIMAP(**cfg).fit_transform(X)
    except ImportError:
        # Fallback to UMAP if trimap is not available
        try:
            print("Warning: TriMAP package not found, falling back to UMAP")
            # Create a copy of cfg to avoid modifying the original
            umap_cfg = cfg.copy()
            
            # Remove TriMAP-specific parameters that UMAP doesn't support
            trimap_specific_params = [
                "n_inliers", "n_outliers", "weight_adj", "lr", "n_iters",
                "n_random", "distance", "apply_pca", "verbose"
            ]
            for param in trimap_specific_params:
                if param in umap_cfg:
                    umap_cfg.pop(param)
            
            # Map similar parameters to UMAP equivalents
            if "n_iters" in cfg and "n_epochs" not in umap_cfg:
                umap_cfg["n_epochs"] = cfg["n_iters"]
                
            # Map n_neighbors if it exists
            if "n_neighbors" not in umap_cfg and "n_neighbors" in cfg:
                umap_cfg["n_neighbors"] = cfg["n_neighbors"]
                
            return umap(X, **umap_cfg)
        except Exception as e:
            raise ImportError(f"TriMAP package is not installed and fallback to UMAP failed: {str(e)}. Please install TriMAP with: pip install trimap")

def tsnepso(X, **cfg):
    try:
        from tsne_pso import TSNEPSO
        
        # Set default values for parameters if not provided
        defaults = {
            "n_components": 2,
            "perplexity": 30,
            "n_iter": 500,
            "n_particles": 10,
            "inertia_weight": 0.7,
            "learning_rate": 200,
            "h": 1e-20,
            "f": 1e-21,
            "use_hybrid": True,
            "dynamic_weight_adaptation": True,
            "parameter_optimization": True,
            "small_dataset_handling": True,
            "numerical_robustness": True
        }
        
        # Apply defaults for missing parameters
        for key, value in defaults.items():
            if key not in cfg:
                cfg[key] = value
                
        return TSNEPSO(**cfg).fit_transform(X)
    except ImportError:
        # Fallback to UMAP or sklearn's TSNE if tsne_pso is not available
        try:
            print("Warning: TSNE-PSO package not found, falling back to UMAP")
            return umap(X, **cfg)
        except Exception as e:
            try:
                print("Warning: TSNE-PSO and UMAP packages not found, falling back to sklearn's TSNE")
                from sklearn.manifold import TSNE
                tsne_cfg = {k: v for k, v in cfg.items() if k in ["n_components", "perplexity", "learning_rate", "n_iter"]}
                return TSNE(**tsne_cfg).fit_transform(X)
            except Exception as e2:
                raise ImportError(f"TSNE-PSO package is not installed and fallbacks failed: {str(e)}, {str(e2)}. Please install TSNE-PSO with: pip install tsne-pso")

def glle(X, **cfg):
    try:
        from GLLE.functions.my_GLLE import My_GLLE
        from GLLE.functions.my_GLLE_DirectSampling import My_GLLE_DirectSampling
        
        # Set default values for parameters if not provided
        defaults = {
            "method": "GLLE",
            "k_neighbors": 10,
            "max_iterations": 100,
            "n_components": 2,
            "verbosity": True
        }
        
        # Apply defaults for missing parameters
        for key, value in defaults.items():
            if key not in cfg:
                cfg[key] = value
        
        # Prepare common parameters for GLLE
        common = dict(X=X.T,
                     n_neighbors=cfg["k_neighbors"],
                     n_components=cfg["n_components"],
                     path_save=".",
                     verbosity=cfg["verbosity"])
        
        # Choose algorithm based on method parameter
        Model = My_GLLE if cfg["method"] == "GLLE" else My_GLLE_DirectSampling
        
        if Model is My_GLLE:
            mdl = Model(max_itr_reconstruction=cfg["max_iterations"], **common)
        else:
            mdl = Model(**common)
            
        return mdl.fit_transform(calculate_again=True).T
    except ImportError:
        # Fallback to UMAP if GLLE is not available
        try:
            print("Warning: GLLE package not found, falling back to UMAP")
            return umap(X, **cfg)
        except Exception as e:
            raise ImportError(f"GLLE package is not installed and fallback to UMAP failed: {str(e)}. Please install GLLE manually.")
    except Exception as e:
        print(f"Error in GLLE: {str(e)}, falling back to UMAP")
        return umap(X, **cfg)

def clmds(X, **cfg):
    try:
        from scipy.spatial.distance import pdist, squareform
        from cluster_mds import clMDS
        
        # Set default values for parameters if not provided
        defaults = {
            "n_clusters": 5,
            "max_iter": 300,
            "verbose": False
        }
        
        # Apply defaults for missing parameters
        for key, value in defaults.items():
            if key not in cfg:
                cfg[key] = value
        
        # Calculate distance matrix
        D = squareform(pdist(X, metric="euclidean"))
        
        # Initialize clMDS with verbose parameter
        m = clMDS(D, verbose=cfg["verbose"])
        
        # Run cluster_MDS with remaining parameters
        m.cluster_MDS(
            hierarchy=[cfg["n_clusters"], 1],
            max_iter_cluster=cfg["max_iter"]
        )
        
        return m.local_sparse_coordinates
    except ImportError:
        # Fallback to UMAP if cluster_mds is not available
        try:
            print("Warning: cluster_mds package not found, falling back to UMAP")
            return umap(X, **cfg)
        except Exception as e:
            raise ImportError(f"cluster_mds package is not installed and fallback to UMAP failed: {str(e)}. Please install cluster_mds manually.")
    except Exception as e:
        print(f"Error in clMDS: {str(e)}, falling back to UMAP")
        return umap(X, **cfg)
# … add other wrappers as needed …

ALGOS = {
    "umap": umap,
    "tsne": tsne,
    "phate": phate,
   "pacmap": pacmap,
    "spacemap": spacemap,
    "trimap": trimap,
    "tsnepso": tsnepso,
    "glle": glle,
    "clmds": clmds
}

# ───────────────────────────────────────────────────────────────
# 2) Dynamic metadata (single source of truth)
# ───────────────────────────────────────────────────────────────
SUBSET_STRATS = ["random", "artist_first5"]  # extendable

PARAM_DEFS = {
    "umap": [
        {"name":"n_neighbors","type":"range","min":5,"max":50,"step":1,"value":15},
        {"name":"min_dist",   "type":"range","min":0,"max":0.4,"step":0.01,"value":0.1},
        {"name":"metric",     "type":"select","options":["euclidean","cosine","manhattan"],"value":"euclidean"},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2}
    ],
    "tsne": [
        {"name":"perplexity","type":"range","min":5,"max":50,"step":1,"value":30},
        {"name":"n_iter",    "type":"range","min":250,"max":1000,"step":50,"value":500},
        {"name":"learning_rate","type":"range","min":10,"max":1000,"step":10,"value":200},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2}
    ],
    "phate": [
        {"name":"knn","type":"range","min":5,"max":50,"step":1,"value":5},
        {"name":"decay","type":"range","min":2,"max":60,"step":1,"value":40},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2}
    ],
      "pacmap": [
        {"name":"n_neighbors","type":"range","min":1,"max":30,"step":1,"value":10},
        {"name":"num_iters","type":"range","min":200,"max":1000,"step":50,"value":450},
        {"name":"lr","type":"range","min":0.1,"max":5,"step":0.1,"value":1},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2},
        {"name":"MN_ratio","type":"range","min":0.1,"max":1,"step":0.05,"value":0.5},
        {"name":"FP_ratio","type":"range","min":0.5,"max":4,"step":0.1,"value":2},
        {"name":"apply_pca","type":"checkbox","value":True},
        {"name":"preprocess_pca","type":"range","min":5,"max":50,"step":5,"value":50},
        {"name":"backend","type":"select","options":["annoy","hnswlib"],"value":"annoy"},
        {"name":"verbose","type":"checkbox","value":False}
    ],
    "spacemap": [
        {"name":"n_near_field","type":"range","min":10,"max":100,"step":1,"value":21},
        {"name":"n_middle_field","type":"range","min":20,"max":80,"step":1,"value":50},
        {"name":"eta","type":"range","min":0.01,"max":1,"step":0.05,"value":0.6},
        {"name":"n_epochs","type":"range","min":100,"max":400,"step":50,"value":200},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2},
        {"name":"d_local","type":"range","min":0,"max":5,"step":1,"value":0},
        {"name":"d_global","type":"range","min":1,"max":10,"step":0.5,"value":4.5},
        {"name":"init","type":"select","options":["spectral","random"],"value":"spectral"},
        {"name":"metric","type":"select","options":["euclidean","cosine"],"value":"euclidean"},
        {"name":"verbose","type":"checkbox","value":True}
    ],
    "trimap": [
        {"name":"n_inliers","type":"range","min":10,"max":30,"step":1,"value":12},
        {"name":"n_outliers","type":"range","min":2,"max":10,"step":1,"value":4},
        {"name":"n_random","type":"range","min":1,"max":10,"step":1,"value":3},
        {"name":"n_iters","type":"range","min":200,"max":1000,"step":50,"value":400},
        {"name":"lr","type":"range","min":0.05,"max":0.2,"step":0.01,"value":0.1},
        {"name":"apply_pca","type":"checkbox","value":True},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2}
    ],
    "tsnepso": [
        {"name":"perplexity","type":"range","min":5,"max":50,"step":1,"value":30},
        {"name":"n_iter","type":"range","min":250,"max":1000,"step":50,"value":500},
        {"name":"n_particles","type":"range","min":5,"max":20,"step":1,"value":10},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2},
        {"name":"inertia_weight","type":"range","min":0.5,"max":0.9,"step":0.05,"value":0.7},
        {"name":"learning_rate","type":"range","min":50,"max":1000,"step":10,"value":200},
        {"name":"h","type":"range","min":1e-22,"max":1e-18,"step":1e-22,"value":1e-20},
        {"name":"f","type":"range","min":1e-22,"max":1e-18,"step":1e-22,"value":1e-21},
        {"name":"use_hybrid","type":"checkbox","value":True},
        {"name":"dynamic_weight_adaptation","type":"checkbox","value":True},
        {"name":"parameter_optimization","type":"checkbox","value":True},
        {"name":"small_dataset_handling","type":"checkbox","value":True},
        {"name":"numerical_robustness","type":"checkbox","value":True}
    ],
    "glle": [
        {"name":"method","type":"select","options":["GLLE","GLLE_DirectSampling"],"value":"GLLE"},
        {"name":"k_neighbors","type":"range","min":5,"max":30,"step":1,"value":10},
        {"name":"max_iterations","type":"range","min":10,"max":200,"step":10,"value":50},
        {"name":"n_components","type":"range","min":2,"max":3,"step":1,"value":2},
        {"name":"verbosity","type":"checkbox","value":True}
    ],
    "clmds": [
        {"name":"n_clusters","type":"range","min":2,"max":20,"step":1,"value":5},
        {"name":"max_iter","type":"range","min":100,"max":1000,"step":50,"value":300},
        {"name":"verbose","type":"checkbox","value":False}
    ]
}

# ───────────────────────────────────────────────────────────────
# 3) CLI setup with listing flags
# ───────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(prog="dr.py")
group = parser.add_mutually_exclusive_group()
group.add_argument("--list-methods", action="store_true",
                   help="Emit JSON list of available DR methods")
group.add_argument("--list-subsets", action="store_true",
                   help="Emit JSON list of subset strategies")
group.add_argument("--list-params", metavar="METHOD",
                   help="Emit JSON param definitions for a given METHOD")

parser.add_argument("--method", choices=sorted(ALGOS), help="Algorithm to run")
parser.add_argument("--subset-strategy", default="random", help="Sampling strategy")
parser.add_argument("--subset-size", type=int, default=250, help="Max points (1–500)")
parser.add_argument("--param", action="append", default=[],
                    help="Override hyperparam (k=JSON_VALUE)")
parser.add_argument("--config-id", type=int,
                    help="Overwrite existing config row if provided")

args = parser.parse_args()

# ───────────────────────────────────────────────────────────────
# 4) Handle listing requests early
# ───────────────────────────────────────────────────────────────
if args.list_methods:
    print_json(list(ALGOS.keys()))
    sys.exit(0)

if args.list_subsets:
    print_json(SUBSET_STRATS)
    sys.exit(0)

if args.list_params:
    defs = PARAM_DEFS.get(args.list_params)
    if defs is None:
        print_json({"error":f"Unknown method: {args.list_params}"})
        sys.exit(1)
    print_json(defs)
    sys.exit(0)

# ───────────────────────────────────────────────────────────────
# 5) Main DR flow
# ───────────────────────────────────────────────────────────────
def _parse_kv(pairs: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kv in pairs:
        k, v = kv.split("=",1)
        try:
            # Try to parse as JSON
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            # Handle boolean values explicitly
            if v.lower() == 'true':
                out[k] = True
            elif v.lower() == 'false':
                out[k] = False
            # Handle numeric values
            elif v.replace('.', '', 1).isdigit():
                # Check if it's a float or int
                if '.' in v:
                    out[k] = float(v)
                else:
                    out[k] = int(v)
            else:
                # Keep as string if all else fails
                out[k] = v
    return out

# Handle deprecated parameters
def _handle_deprecated_params(cfg: dict) -> dict:
    """Update deprecated parameters to their new names"""
    # Create a copy to avoid modifying the original
    updated_cfg = cfg.copy()
    
    # Handle force_all_finite -> ensure_all_finite
    if "force_all_finite" in updated_cfg and "ensure_all_finite" not in updated_cfg:
        updated_cfg["ensure_all_finite"] = updated_cfg.pop("force_all_finite")
    
    # Handle n_iter -> max_iter (for t-SNE)
    if "n_iter" in updated_cfg and "max_iter" not in updated_cfg:
        updated_cfg["max_iter"] = updated_cfg.pop("n_iter")
    
    return updated_cfg

cfg = _parse_kv(args.param)

# Handle deprecated parameters
cfg = _handle_deprecated_params(cfg)

# clamp subset size
size = max(1, min(500, args.subset_size))

# fetch high-dim embeddings + metadata
X, meta = db.fetch_subset(args.subset_strategy, size,
                          rng_state=cfg.get("random_state"))

# run the chosen algorithm
t0 = time.time()
Y = ALGOS[args.method](X, **cfg)
runtime = time.time() - t0

# upsert config & save projected points
cid = db.upsert_config(args.method, args.subset_strategy, size, cfg, runtime,
                       config_id=args.config_id)
db.save_points(cid, [(m["filename"], m["artist"], x, y) for m,(x,y) in zip(meta,Y)])

# emit full JSON blob for server
result = db.load_config_blob(cid)
# Use separators to make the JSON more compact
print_json(result)
