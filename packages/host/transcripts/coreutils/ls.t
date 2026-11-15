# ls: the default listing on a terminal (columns, 80 wide) and in a pipe (one per line), -1, -C,
# -x, -m, widths and tab stops, hidden files, -d, -R, several operands, ignore patterns.
# tags: golden-verified
% mkdir t && cd t && touch alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega
$ ls
alpha  delta	gamma  lambda  omega	pi   sigma  upsilon
beta   epsilon	iota   mu      omicron	psi  tau    xi
chi    eta	kappa  nu      phi	rho  theta  zeta
$ ls | cat
alpha
beta
chi
delta
epsilon
eta
gamma
iota
kappa
lambda
mu
nu
omega
omicron
phi
pi
psi
rho
sigma
tau
theta
upsilon
xi
zeta
$ ls -1
alpha
beta
chi
delta
epsilon
eta
gamma
iota
kappa
lambda
mu
nu
omega
omicron
phi
pi
psi
rho
sigma
tau
theta
upsilon
xi
zeta
$ ls -x
alpha  beta	chi  delta  epsilon  eta  gamma  iota  kappa  lambda   mu  nu
omega  omicron	phi  pi     psi      rho  sigma  tau   theta  upsilon  xi  zeta
$ ls -m
alpha, beta, chi, delta, epsilon, eta, gamma, iota, kappa, lambda, mu, nu,
omega, omicron, phi, pi, psi, rho, sigma, tau, theta, upsilon, xi, zeta
$ ls -C | cat
alpha  delta	gamma  lambda  omega	pi   sigma  upsilon
beta   epsilon	iota   mu      omicron	psi  tau    xi
chi    eta	kappa  nu      phi	rho  theta  zeta
$ ls -x | cat
alpha  beta	chi  delta  epsilon  eta  gamma  iota  kappa  lambda   mu  nu
omega  omicron	phi  pi     psi      rho  sigma  tau   theta  upsilon  xi  zeta
$ ls -w 40
alpha	 gamma	 omega	  sigma
beta	 iota	 omicron  tau
chi	 kappa	 phi	  theta
delta	 lambda  pi	  upsilon
epsilon  mu	 psi	  xi
eta	 nu	 rho	  zeta
$ ls -x -w 30
alpha	 beta	  chi
delta	 epsilon  eta
gamma	 iota	  kappa
lambda	 mu	  nu
omega	 omicron  phi
pi	 psi	  rho
sigma	 tau	  theta
upsilon  xi	  zeta
$ ls -m -w 30
alpha, beta, chi, delta,
epsilon, eta, gamma, iota,
kappa, lambda, mu, nu, omega,
omicron, phi, pi, psi, rho,
sigma, tau, theta, upsilon,
xi, zeta
$ ls -C -w 0
alpha  beta  chi  delta  epsilon  eta  gamma  iota  kappa  lambda  mu  nu  omega  omicron  phi  pi  psi  rho  sigma  tau  theta  upsilon  xi  zeta
$ ls -w 30 -T 4
alpha	 kappa	  psi
beta	 lambda   rho
chi		 mu		  sigma
delta	 nu		  tau
epsilon  omega	  theta
eta		 omicron  upsilon
gamma	 phi	  xi
iota	 pi		  zeta
$ ls -w 30 -T 0
alpha    kappa    psi
beta     lambda   rho
chi      mu       sigma
delta    nu       tau
epsilon  omega    theta
eta      omicron  upsilon
gamma    phi      xi
iota     pi       zeta
$ ls --width=60 --tabsize=5
alpha  delta	 gamma  lambda  omega	pi	sigma  upsilon
beta   epsilon  iota   mu	 omicron	psi	tau	  xi
chi	  eta	 kappa  nu	 phi		rho	theta  zeta
$ COLUMNS=50 ls
alpha  delta	gamma  lambda  omega	pi   sigma  upsilon
beta   epsilon	iota   mu      omicron	psi  tau    xi
chi    eta	kappa  nu      phi	rho  theta  zeta
$ COLUMNS=50 ls -C | cat
alpha  epsilon	kappa	omega	 psi	theta
beta   eta	lambda	omicron  rho	upsilon
chi    gamma	mu	phi	 sigma	xi
delta  iota	nu	pi	 tau	zeta
$ COLUMNS=abc ls -x | cat
ls: ignoring invalid width in environment variable COLUMNS: ‘abc’
alpha  beta	chi  delta  epsilon  eta  gamma  iota  kappa  lambda   mu  nu
omega  omicron	phi  pi     psi      rho  sigma  tau   theta  upsilon  xi  zeta
$ ls -1 -C -w 50
alpha  epsilon	kappa	omega	 psi	theta
beta   eta	lambda	omicron  rho	upsilon
chi    gamma	mu	phi	 sigma	xi
delta  iota	nu	pi	 tau	zeta
$ ls --format=across -w 50
alpha  beta	chi    delta	epsilon  eta
gamma  iota	kappa  lambda	mu	 nu
omega  omicron	phi    pi	psi	 rho
sigma  tau	theta  upsilon	xi	 zeta
$ ls --format=commas -w 50
alpha, beta, chi, delta, epsilon, eta, gamma,
iota, kappa, lambda, mu, nu, omega, omicron, phi,
pi, psi, rho, sigma, tau, theta, upsilon, xi,
zeta
$ ls --format=single-column -w 50 | cat
alpha
beta
chi
delta
epsilon
eta
gamma
iota
kappa
lambda
mu
nu
omega
omicron
phi
pi
psi
rho
sigma
tau
theta
upsilon
xi
zeta
$ ls --format=vertical -w 50 | cat
alpha  epsilon	kappa	omega	 psi	theta
beta   eta	lambda	omicron  rho	upsilon
chi    gamma	mu	phi	 sigma	xi
delta  iota	nu	pi	 tau	zeta
#
# Hidden files, -a, -A, -d.
% touch .hidden .config && mkdir sub sub/.dotdir && touch sub/inner sub/.inner
$ ls -a
.	 .hidden  chi	   eta	  kappa   nu	   phi	rho    tau	xi
..	 alpha	  delta    gamma  lambda  omega    pi	sigma  theta	zeta
.config  beta	  epsilon  iota   mu	  omicron  psi	sub    upsilon
$ ls -A
.config  beta	epsilon  iota	 mu	omicron  psi	sub    upsilon
.hidden  chi	eta	 kappa	 nu	phi	 rho	tau    xi
alpha	 delta	gamma	 lambda  omega	pi	 sigma	theta  zeta
$ ls -A1
.config
.hidden
alpha
beta
chi
delta
epsilon
eta
gamma
iota
kappa
lambda
mu
nu
omega
omicron
phi
pi
psi
rho
sigma
sub
tau
theta
upsilon
xi
zeta
$ ls -d
.
$ ls -d sub
sub
$ ls -d sub/ alpha
alpha  sub/
$ ls sub
inner
$ ls -a sub
.  ..  .dotdir	.inner	inner
$ ls -A sub
.dotdir  .inner  inner
$ ls -ad sub
sub
#
# Several operands: errors first, then files, then directories with headers.
$ ls . sub
.:
alpha  delta	gamma  lambda  omega	pi   sigma  theta    zeta
beta   epsilon	iota   mu      omicron	psi  sub    upsilon
chi    eta	kappa  nu      phi	rho  tau    xi

sub:
inner
$ ls sub alpha nope beta zz
ls: cannot access 'nope': No such file or directory
ls: cannot access 'zz': No such file or directory
alpha  beta

sub:
inner
[exit 2]
$ ls -1 sub alpha
alpha

sub:
inner
$ ls -x sub alpha beta
alpha  beta

sub:
inner
$ ls nope
ls: cannot access 'nope': No such file or directory
[exit 2]
$ ls nope zz
ls: cannot access 'nope': No such file or directory
ls: cannot access 'zz': No such file or directory
[exit 2]
$ ls ''
ls: cannot access '': No such file or directory
[exit 2]
$ ls -- -x
ls: cannot access '-x': No such file or directory
[exit 2]
$ ls alpha alpha
alpha  alpha
#
# Recursive listings.
% mkdir sub/deep && touch sub/deep/f1 sub/deep/f2
$ ls -R
.:
alpha  delta	gamma  lambda  omega	pi   sigma  theta    zeta
beta   epsilon	iota   mu      omicron	psi  sub    upsilon
chi    eta	kappa  nu      phi	rho  tau    xi

./sub:
deep  inner

./sub/deep:
f1  f2
$ ls -R sub
sub:
deep  inner

sub/deep:
f1  f2
$ ls -aR sub
sub:
.  ..  .dotdir	.inner	deep  inner

sub/.dotdir:
.  ..

sub/deep:
.  ..  f1  f2
$ ls -AR sub
sub:
.dotdir  .inner  deep  inner

sub/.dotdir:

sub/deep:
f1  f2
$ ls -R1 sub alpha
alpha

sub:
deep
inner

sub/deep:
f1
f2
#
# Patterns: -B hides backups, -I and --hide hide matches (--hide only without -a and -A).
% touch notes.txt~ .old~ x.txt
$ ls
alpha  delta	gamma  lambda	   nu	    phi  rho	tau	 x.txt
beta   epsilon	iota   mu	   omega    pi	 sigma	theta	 xi
chi    eta	kappa  notes.txt~  omicron  psi  sub	upsilon  zeta
$ ls -B
alpha  delta	gamma  lambda  omega	pi   sigma  theta    xi
beta   epsilon	iota   mu      omicron	psi  sub    upsilon  zeta
chi    eta	kappa  nu      phi	rho  tau    x.txt
$ ls -aB sub
.  ..  .dotdir	.inner	deep  inner
$ ls -I '*a'
chi	 mu	     nu       phi  psi	sub  upsilon  xi
epsilon  notes.txt~  omicron  pi   rho	tau  x.txt
$ ls -I '*a' -I '*u*'
chi  epsilon  notes.txt~  omicron  phi	pi  psi  rho  x.txt  xi
$ ls --ignore='[a-m]*'
notes.txt~  omega    phi  psi  sigma  tau    upsilon  xi
nu	    omicron  pi   rho  sub    theta  x.txt    zeta
$ ls --hide='*a'
chi	 mu	     nu       phi  psi	sub  upsilon  xi
epsilon  notes.txt~  omicron  pi   rho	tau  x.txt
$ ls -A --hide='*a'
.config  alpha	delta	 gamma	lambda	    nu	     phi  rho	 tau	  x.txt
.hidden  beta	epsilon  iota	mu	    omega    pi   sigma  theta	  xi
.old~	 chi	eta	 kappa	notes.txt~  omicron  psi  sub	 upsilon  zeta
$ ls -a -I '.*'
alpha  delta	gamma  lambda	   nu	    phi  rho	tau	 x.txt
beta   epsilon	iota   mu	   omega    pi	 sigma	theta	 xi
chi    eta	kappa  notes.txt~  omicron  psi  sub	upsilon  zeta
$ ls -A -I '*'
.config  .hidden  .old~
